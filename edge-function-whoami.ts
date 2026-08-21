// Point d'entrée unique pour l'app mobile (Capacitor) : après
// connexion, détermine à quel portail rediriger — propriétaire,
// locataire ou travailleur — sans que l'app ait à le deviner ou à le
// stocker elle-même. Aucune des 3 tables n'a de policy RLS de lecture
// directe cohérente pour "son propre user_id" (owners/tenants en ont
// une, workers non — voir worker-api.ts get_my_profile), donc ce
// contrôle se fait ici, côté serveur, service_role, une fois pour les
// 3 rôles plutôt que de dupliquer la logique dans chaque portail.
const ALLOWED_ORIGINS = ["https://portailgestion.ca", "https://www.portailgestion.ca"];
function corsHeadersFor(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
}

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

    const [ownerRes, tenantRes, workerRes] = await Promise.all([
      fetch(`${supabaseUrl}/rest/v1/owners?user_id=eq.${userId}&select=id`, { headers: adminHeaders }),
      fetch(`${supabaseUrl}/rest/v1/tenants?user_id=eq.${userId}&select=id`, { headers: adminHeaders }),
      fetch(`${supabaseUrl}/rest/v1/workers?user_id=eq.${userId}&select=id`, { headers: adminHeaders }),
    ]);
    const [[owner], [tenant], [worker]] = await Promise.all([
      ownerRes.json().catch(() => [null]),
      tenantRes.json().catch(() => [null]),
      workerRes.json().catch(() => [null]),
    ]);

    const role = owner?.id ? "owner" : tenant?.id ? "tenant" : worker?.id ? "worker" : null;
    if (!role) {
      return new Response(JSON.stringify({ error: "Aucun portail associé à ce compte." }), { status: 403, headers: corsHeaders });
    }
    return new Response(JSON.stringify({ role }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
