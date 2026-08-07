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
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

Deno.serve(async (req) => {
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
    if (action === "sync_all") {
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

    // ---- Actions admin : JWT requis ----
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), { status: 401, headers: corsHeaders });
    }
    const claims = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    const userId = claims.sub;
    const userRes = await fetch(`${supabaseUrl}/rest/v1/users?id=eq.${userId}&select=is_admin`, { headers: adminHeaders });
    const [user] = await userRes.json();
    if (!user?.is_admin) {
      return new Response(JSON.stringify({ error: "Accès refusé — compte non admin" }), { status: 403, headers: corsHeaders });
    }

    if (action === "generate_connect_token") {
      const token = await flinksGenerateAuthorizeToken();
      return new Response(JSON.stringify({
        ok: true, token, customer_id: FLINKS_CUSTOMER_ID, iframe_base_url: FLINKS_IFRAME_BASE_URL,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "link_account") {
      const { owner_id, login_id } = body;
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
      await logAudit("admin", userId, "bank_connection.linked", null, { owner_id, institution_name: auth.InstitutionName });
      return new Response(JSON.stringify({ ok: true, institution_name: auth.InstitutionName }), { status: 200, headers: corsHeaders });
    }

    if (action === "list_connections") {
      const res = await fetch(`${supabaseUrl}/rest/v1/bank_connections?select=*,owners(full_name)&order=created_at.desc`, { headers: adminHeaders });
      return new Response(JSON.stringify({ connections: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "sync_now") {
      const { connection_id } = body;
      if (!connection_id) {
        return new Response(JSON.stringify({ error: "connection_id manquant" }), { status: 400, headers: corsHeaders });
      }
      const connRes = await fetch(`${supabaseUrl}/rest/v1/bank_connections?id=eq.${connection_id}&select=id,owner_id,flinks_login_id`, { headers: adminHeaders });
      const [conn] = await connRes.json();
      if (!conn) {
        return new Response(JSON.stringify({ error: "Connexion introuvable" }), { status: 404, headers: corsHeaders });
      }
      try {
        const result = await syncOneConnection(conn);
        await logAudit("admin", userId, "bank_connection.manual_sync", connection_id, result);
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
      await fetch(`${supabaseUrl}/rest/v1/bank_connections?id=eq.${connection_id}`, {
        method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "disconnected" }),
      });
      await logAudit("admin", userId, "bank_connection.disconnected", connection_id, {});
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    console.error("flinks-api unexpected error", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
