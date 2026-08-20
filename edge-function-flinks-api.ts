// Connexion bancaire en lecture seule via Flinks (Connect - Data
// Aggregation). Aucun identifiant bancaire n'est jamais stocké côté
// Portail — seulement le LoginId retourné par le widget Flinks Connect
// une fois le propriétaire connecté à sa banque.
//
// Actions ADMIN (JWT requis, is_admin) :
//   - generate_connect_token : jeton pour embarquer le widget Flinks Connect
//   - link_account           : enregistre la connexion après un lien réussi
//   - list_connections       : liste les connexions bancaires par propriétaire
//   - sync_now               : synchronise une seule connexion, à la demande
//   - disconnect             : désactive une connexion
//
// Action SYSTÈME (déclenchée par pg_cron, sans JWT utilisateur) :
//   - sync_all : synchronise toutes les connexions actives, une fois par
//     jour (voir trigger_flinks_daily_sync() dans schema.sql). Les
//     transactions récupérées sont envoyées à reconcile-bank-transactions
//     (action import_csv) pour réutiliser exactement le même moteur de
//     matching déterministe que l'import CSV manuel.
// Liste blanche d'origines : évite d'exposer les fonctions à un
// site tiers qui embarquerait un appel authentifié depuis le
// navigateur d'un usager (CSRF via fetch). Les appels serveur à
// serveur (cron, webhooks, autre fonction edge) n'envoient pas
// d'en-tête Origin et ne sont donc pas affectés par ce contrôle.
const ALLOWED_ORIGINS = ["https://portailgestion.ca", "https://www.portailgestion.ca"];
function corsHeadersFor(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
    // Durcissement (Lot 7 TWIM) : ces en-têtes ne coûtent rien et
    // réduisent la surface d'attaque même si le contenu JSON renvoyé
    // n'est pas du HTML — défense en profondeur, pas une réaction à un
    // vecteur d'attaque identifié ici.
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
}

const FLINKS_API_BASE_URL = Deno.env.get("FLINKS_API_BASE_URL") || "https://toolbox-api.private.fin.ag";
const FLINKS_IFRAME_BASE_URL = Deno.env.get("FLINKS_IFRAME_BASE_URL") || "https://toolbox-iframe.private.fin.ag";
const FLINKS_CUSTOMER_ID = Deno.env.get("FLINKS_CUSTOMER_ID") || "";
const FLINKS_SECRET_KEY = Deno.env.get("FLINKS_SECRET_KEY") || "";
const FLINKS_API_KEY = Deno.env.get("FLINKS_API_KEY") || "";

type FlinksTransaction = { Id: string; Date: string; Description: string; Debit: number | null; Credit: number | null };
type FlinksAccount = { Id: string; Title: string; Transactions: FlinksTransaction[] };

async function flinksGenerateAuthorizeToken(): Promise<string> {
  const res = await fetch(`${FLINKS_API_BASE_URL}/v3/${FLINKS_CUSTOMER_ID}/BankingServices/GenerateAuthorizeToken`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "flinks-auth-key": FLINKS_SECRET_KEY },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.Token) throw new Error("Impossible de générer le jeton Flinks");
  return data.Token as string;
}

async function flinksAuthorize(token: string, loginId: string): Promise<{ RequestId: string; InstitutionName: string }> {
  const res = await fetch(`${FLINKS_API_BASE_URL}/v3/${FLINKS_CUSTOMER_ID}/BankingServices/Authorize`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "flinks-auth-key": token },
    body: JSON.stringify({ LoginId: loginId, MostRecentCached: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 203) {
    throw new Error("Authentification multi-facteurs requise — reconnecte le compte via le widget Flinks Connect.");
  }
  if (!res.ok || !data?.RequestId) throw new Error("Impossible d'ouvrir une session Flinks pour ce compte");
  return { RequestId: data.RequestId, InstitutionName: data.InstitutionName };
}

async function flinksGetAccountsDetail(token: string, requestId: string): Promise<FlinksAccount[]> {
  const res = await fetch(`${FLINKS_API_BASE_URL}/v3/${FLINKS_CUSTOMER_ID}/BankingServices/GetAccountsDetail`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "flinks-auth-key": token,
      "x-api-key": FLINKS_API_KEY,
    },
    body: JSON.stringify({
      RequestId: requestId,
      WithAccountIdentity: false,
      WithKYC: false,
      WithTransactions: true,
      DaysOfTransactions: "Days90",
      WithDetailsAndBankingStatements: false,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(data?.Accounts)) throw new Error("Impossible de récupérer les transactions Flinks");
  return data.Accounts as FlinksAccount[];
}

// Vérifie la signature du JWT (HS256, secret du projet Supabase) au lieu
// de se fier uniquement au réglage "Verify JWT" de la plateforme —
// défense en profondeur : cette fonction reste sûre même si ce réglage
// est mal configuré pour une fonction en particulier.
// Vérifie le JWT en le faisant valider par le service Auth de Supabase
// lui-même (GET /auth/v1/user) plutôt qu'en réimplémentant la
// cryptographie de vérification. La passerelle Edge Functions a un bug
// connu qui rejette à tort les JWT signés en ES256 quand verify_jwt=true
// est réglé au niveau plateforme (github.com/supabase/supabase/issues/42244)
// — d'où verify_jwt=false dans supabase/config.toml pour cette fonction :
// ce code est maintenant la seule vérification, et s'appuie sur l'API
// Auth de Supabase, qui elle gère ES256 correctement.
async function verifySupabaseJwt(jwt: string, supabaseUrl: string): Promise<{ sub: string; [key: string]: unknown } | null> {
  if (!jwt) return null;
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      },
    });
    if (!res.ok) return null;
    const user = await res.json().catch(() => null);
    if (!user?.id) return null;
    return { sub: user.id, ...user };
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const flinksSyncSecret = Deno.env.get("FLINKS_SYNC_SECRET") || "";
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const body = await req.json().catch(() => ({}));
    const action = body.action;

    const logAudit = (actorType: string, actorId: string | null, action2: string, entityId: string | null, details: Record<string, unknown>) =>
      fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ actor_type: actorType, actor_id: actorId, action: action2, entity_type: "bank_connections", entity_id: entityId, details }),
      });

    // Réutilise le moteur de matching déterministe existant en appelant
    // reconcile-bank-transactions (import_csv) avec la clé système —
    // aucune logique de scoring dupliquée ici.
    const importRows = async (ownerId: string, rows: Array<{ date: string; amount: number; description: string; reference: string }>) => {
      const res = await fetch(`${supabaseUrl}/functions/v1/reconcile-bank-transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: anonKey, Authorization: `Bearer ${anonKey}`, "x-flinks-sync-key": flinksSyncSecret },
        body: JSON.stringify({ action: "import_csv", owner_id: ownerId, rows }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Échec de l'import des transactions Flinks");
      return Array.isArray(data.results) ? data.results : [];
    };

    const syncOneConnection = async (conn: { id: string; owner_id: string; flinks_login_id: string }) => {
      const token = await flinksGenerateAuthorizeToken();
      const auth = await flinksAuthorize(token, conn.flinks_login_id);
      const accounts = await flinksGetAccountsDetail(token, auth.RequestId);

      const rows: Array<{ date: string; amount: number; description: string; reference: string }> = [];
      for (const account of accounts) {
        for (const tx of account.Transactions || []) {
          const amount = Number(tx.Credit || 0) - Number(tx.Debit || 0);
          if (!amount) continue;
          rows.push({ date: tx.Date, amount, description: tx.Description || account.Title, reference: `flinks:${tx.Id}` });
        }
      }

      const results = rows.length ? await importRows(conn.owner_id, rows) : [];
      const imported = results.filter((r: any) => !r?.skipped).length;

      await fetch(`${supabaseUrl}/rest/v1/bank_connections?id=eq.${conn.id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ status: "active", last_synced_at: new Date().toISOString(), last_sync_error: null, institution_name: auth.InstitutionName }),
      });

      return { institution_name: auth.InstitutionName, fetched: rows.length, imported };
    };

    // ---- Action système : appelée par pg_cron (voir trigger_flinks_daily_sync) ----
    // CORRECTIF SÉCURITÉ : cette action déclenchait une vraie synchronisation
    // bancaire pour TOUS les propriétaires connectés sans aucune
    // authentification — n'importe qui pouvait la déclencher en connaissant
    // juste l'URL. Protégée maintenant par le même secret partagé que
    // reconcile-bank-transactions (FLINKS_SYNC_SECRET), jamais exposé côté
    // client, lu depuis Supabase Vault côté SQL (voir trigger_flinks_daily_sync
    // dans schema.sql) plutôt qu'écrit en clair dans un fichier public.
    if (action === "sync_all") {
      const systemKey = req.headers.get("x-flinks-sync-key") || "";
      if (!flinksSyncSecret || systemKey !== flinksSyncSecret) {
        return new Response(JSON.stringify({ error: "Non autorisé" }), { status: 403, headers: corsHeaders });
      }
      const connsRes = await fetch(`${supabaseUrl}/rest/v1/bank_connections?status=eq.active&select=id,owner_id,flinks_login_id`, { headers: adminHeaders });
      const connections = await connsRes.json().catch(() => []);
      const results: Record<string, unknown>[] = [];
      for (const conn of Array.isArray(connections) ? connections : []) {
        try {
          const result = await syncOneConnection(conn);
          results.push({ connection_id: conn.id, ok: true, ...result });
        } catch (e) {
          await fetch(`${supabaseUrl}/rest/v1/bank_connections?id=eq.${conn.id}`, {
            method: "PATCH",
            headers: adminHeaders,
            body: JSON.stringify({ status: "error", last_sync_error: String(e) }),
          });
          results.push({ connection_id: conn.id, ok: false, error: String(e) });
        }
      }
      return new Response(JSON.stringify({ ok: true, results }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ---- Actions admin OU propriétaire : JWT requis ----
    // Un propriétaire peut lier/consulter/synchroniser SON PROPRE compte
    // (c'est le chemin recommandé — il entre lui-même ses identifiants
    // bancaires dans le widget Flinks, jamais l'admin). L'admin garde la
    // capacité d'agir pour n'importe quel propriétaire (dépannage).
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), { status: 401, headers: corsHeaders });
    }
    const claims = await verifySupabaseJwt(jwt, Deno.env.get("SUPABASE_URL") ?? "");
    if (!claims) {
      return new Response(JSON.stringify({ error: "Jeton invalide ou expiré" }), { status: 401, headers: corsHeaders });
    }
    const userId = claims.sub as string;
    const userRes = await fetch(`${supabaseUrl}/rest/v1/users?id=eq.${userId}&select=is_admin`, { headers: adminHeaders });
    const [user] = await userRes.json();
    const isAdmin = !!user?.is_admin;

    // On cherche systématiquement un dossier propriétaire lié à ce
    // compte, même s'il est admin — un même compte peut être les deux à
    // la fois (cas d'un opérateur solo, comme en phase pilote).
    const ownerRes = await fetch(`${supabaseUrl}/rest/v1/owners?user_id=eq.${userId}&select=id`, { headers: adminHeaders });
    const [ownerRow] = await ownerRes.json();
    const callerOwnerId: string | null = ownerRow?.id ?? null;

    if (!isAdmin && !callerOwnerId) {
      return new Response(JSON.stringify({ error: "Accès refusé" }), { status: 403, headers: corsHeaders });
    }
    // Priorité : un owner_id explicitement fourni par un admin agissant
    // pour un propriétaire tiers (portail admin) ; sinon le propre
    // dossier du demandeur (portail propriétaire, ou admin qui est aussi
    // propriétaire et n'a rien précisé).
    const resolveOwnerId = (requested?: string) => (isAdmin && requested ? requested : callerOwnerId);
    const actorType = isAdmin ? "admin" : "owner";
    const actorId = isAdmin ? userId : callerOwnerId;

    if (action === "generate_connect_token") {
      const token = await flinksGenerateAuthorizeToken();
      // demo=true active l'institution de test FlinksCapital dans le
      // widget — uniquement en sandbox (instance "toolbox"), retiré
      // automatiquement dès que FLINKS_API_BASE_URL pointera vers Live.
      const isSandbox = FLINKS_API_BASE_URL.includes("toolbox");
      return new Response(JSON.stringify({
        ok: true, token, customer_id: FLINKS_CUSTOMER_ID, iframe_base_url: FLINKS_IFRAME_BASE_URL, is_sandbox: isSandbox,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "link_account") {
      const owner_id = resolveOwnerId(body.owner_id);
      const { login_id } = body;
      if (!owner_id || !login_id) {
        return new Response(JSON.stringify({ error: "owner_id et login_id requis" }), { status: 400, headers: corsHeaders });
      }
      const token = await flinksGenerateAuthorizeToken();
      const auth = await flinksAuthorize(token, login_id);
      await fetch(`${supabaseUrl}/rest/v1/bank_connections`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ owner_id, flinks_login_id: login_id, institution_name: auth.InstitutionName, status: "active" }),
      });
      await logAudit(actorType, actorId, "bank_connection.linked", null, { owner_id, institution_name: auth.InstitutionName });
      return new Response(JSON.stringify({ ok: true, institution_name: auth.InstitutionName }), { status: 200, headers: corsHeaders });
    }

    if (action === "list_connections") {
      // "all" n'est honoré que pour un admin explicitement en mode
      // gestion multi-propriétaires (portail admin) — sinon, même un
      // admin qui est aussi propriétaire ne voit que son propre compte
      // (évite qu'un admin-propriétaire voie les comptes des autres en
      // consultant simplement son propre portail propriétaire).
      const wantsAll = isAdmin && body.all === true;
      const filter = wantsAll ? "" : `&owner_id=eq.${callerOwnerId}`;
      const res = await fetch(`${supabaseUrl}/rest/v1/bank_connections?select=*,owners(full_name)&order=created_at.desc${filter}`, { headers: adminHeaders });
      return new Response(JSON.stringify({ connections: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "sync_now") {
      const { connection_id } = body;
      if (!connection_id) {
        return new Response(JSON.stringify({ error: "connection_id manquant" }), { status: 400, headers: corsHeaders });
      }
      const connRes = await fetch(`${supabaseUrl}/rest/v1/bank_connections?id=eq.${connection_id}&select=id,owner_id,flinks_login_id`, { headers: adminHeaders });
      const [conn] = await connRes.json();
      if (!conn || (!isAdmin && conn.owner_id !== callerOwnerId)) {
        return new Response(JSON.stringify({ error: "Connexion introuvable" }), { status: 404, headers: corsHeaders });
      }
      try {
        const result = await syncOneConnection(conn);
        await logAudit(actorType, actorId, "bank_connection.manual_sync", connection_id, result);
        return new Response(JSON.stringify({ ok: true, ...result }), { status: 200, headers: corsHeaders });
      } catch (e) {
        await fetch(`${supabaseUrl}/rest/v1/bank_connections?id=eq.${connection_id}`, {
          method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "error", last_sync_error: String(e) }),
        });
        return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: corsHeaders });
      }
    }

    if (action === "disconnect") {
      const { connection_id } = body;
      if (!connection_id) {
        return new Response(JSON.stringify({ error: "connection_id manquant" }), { status: 400, headers: corsHeaders });
      }
      const connRes = await fetch(`${supabaseUrl}/rest/v1/bank_connections?id=eq.${connection_id}&select=id,owner_id`, { headers: adminHeaders });
      const [conn] = await connRes.json();
      if (!conn || (!isAdmin && conn.owner_id !== callerOwnerId)) {
        return new Response(JSON.stringify({ error: "Connexion introuvable" }), { status: 404, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/bank_connections?id=eq.${connection_id}`, {
        method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "disconnected" }),
      });
      await logAudit(actorType, actorId, "bank_connection.disconnected", connection_id, {});
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    console.error("flinks-api unexpected error", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
