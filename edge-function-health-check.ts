// Monitoring minimum — endpoint public de santé, fait pour être appelé
// par un moniteur externe (ex: UptimeRobot, gratuit) toutes les 5-10
// minutes, ou consulté manuellement depuis le tableau de bord admin.
// Lecture seule, aucune donnée sensible retournée (que des compteurs et
// des libellés) : safe à exposer sans authentification, comme la clé
// anon publique déjà visible dans le code client. N'envoie jamais
// d'alerte lui-même — ça, c'est le rôle de trigger_health_check_alert()
// (SQL, cron) + send-health-alert.ts, pour éviter de spammer les admins
// à chaque ping d'un moniteur externe.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const healthRes = await fetch(`${supabaseUrl}/rest/v1/rpc/check_system_health`, {
      method: "POST",
      headers: adminHeaders,
      body: "{}",
    });
    if (!healthRes.ok) {
      return new Response(JSON.stringify({ healthy: false, error: "Impossible de joindre la base de données" }), { status: 503, headers: corsHeaders });
    }
    const health = await healthRes.json();

    return new Response(JSON.stringify(health), {
      status: health.healthy ? 200 : 503,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("health-check unexpected error", err);
    return new Response(JSON.stringify({ healthy: false, error: String(err) }), { status: 503, headers: corsHeaders });
  }
});
