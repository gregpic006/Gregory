// API en libre-service pour les propriétaires connectés — distincte de
// ops-api.ts (admin seulement) et de flinks-api.ts (connexion bancaire).
// Première action : ajuster son propre plafond d'approbation
// (spending_cap), comme promis dans politique-de-confidentialite.html
// mais qui n'avait jusqu'ici aucune interface pour le faire.
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

const SPENDING_CAP_MIN = 0;
const SPENDING_CAP_MAX = 50000;

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

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const ownerRes = await fetch(`${supabaseUrl}/rest/v1/owners?user_id=eq.${userId}&select=id,spending_cap`, { headers: adminHeaders });
    const [owner] = await ownerRes.json().catch(() => [null]);
    if (!owner?.id) {
      return new Response(JSON.stringify({ error: "Accès refusé — compte non propriétaire" }), { status: 403, headers: corsHeaders });
    }

    const logAudit = (action: string, details: Record<string, unknown>) =>
      fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ actor_type: "owner", actor_id: owner.id, action, entity_type: "owners", entity_id: owner.id, details }),
      });

    const body = await req.json().catch(() => ({}));
    const action = body.action;

    if (action === "get_spending_cap") {
      return new Response(JSON.stringify({ spending_cap: owner.spending_cap }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "update_spending_cap") {
      const newCap = Number(body.spending_cap);
      if (!Number.isFinite(newCap) || newCap < SPENDING_CAP_MIN || newCap > SPENDING_CAP_MAX) {
        return new Response(JSON.stringify({ error: `Le plafond doit être un montant entre ${SPENDING_CAP_MIN} $ et ${SPENDING_CAP_MAX.toLocaleString("fr-CA")} $` }), { status: 400, headers: corsHeaders });
      }
      const previousCap = owner.spending_cap;
      const patchRes = await fetch(`${supabaseUrl}/rest/v1/owners?id=eq.${owner.id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ spending_cap: newCap }),
      });
      if (!patchRes.ok) {
        return new Response(JSON.stringify({ error: "Impossible d'enregistrer le plafond — réessaie." }), { status: 500, headers: corsHeaders });
      }
      await logAudit("owner.update_spending_cap", { previous_cap: previousCap, new_cap: newCap });
      return new Response(JSON.stringify({ ok: true, spending_cap: newCap }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    console.error("owner-api unexpected error", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
