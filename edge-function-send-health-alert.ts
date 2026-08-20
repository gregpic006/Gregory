// Monitoring minimum — envoie un courriel d'alerte aux admins quand
// check_system_health() détecte un problème. Déclenché uniquement par
// trigger_health_check_alert() via pg_cron/pg_net (aux 15 minutes, avec
// throttling de 2h côté SQL) — jamais appelé directement par un
// utilisateur. Protégé par un secret partagé (comme flinks-api sync_all)
// pour qu'un tiers ne puisse pas spammer les admins avec de fausses
// alertes.
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
  };
}

const severityLabel: Record<string, string> = {
  critical: "🔴 CRITIQUE",
  warning: "🟠 Avertissement",
};

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const healthAlertSecret = Deno.env.get("HEALTH_ALERT_SECRET");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const systemKey = req.headers.get("x-health-alert-key") || "";
    if (!healthAlertSecret || systemKey !== healthAlertSecret) {
      return new Response(JSON.stringify({ error: "Non autorisé" }), { status: 403, headers: corsHeaders });
    }

    const { issues } = await req.json().catch(() => ({ issues: [] }));
    const issueList = Array.isArray(issues) ? issues : [];
    if (issueList.length === 0) {
      return new Response(JSON.stringify({ ok: true, skipped: "no_issues" }), { status: 200, headers: corsHeaders });
    }

    const adminsRes = await fetch(`${supabaseUrl}/rest/v1/users?is_admin=eq.true&select=email`, { headers: adminHeaders });
    const admins = await adminsRes.json().catch(() => []);
    const adminEmails = Array.isArray(admins) ? admins.map((a: any) => a.email).filter(Boolean) : [];
    if (!adminEmails.length) {
      return new Response(JSON.stringify({ ok: false, error: "Aucun admin à notifier" }), { status: 200, headers: corsHeaders });
    }

    const bodyLines = issueList.map((i: any) => `${severityLabel[i.severity] || i.severity} — ${i.detail}`).join("\n");

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Portail <onboarding@mail.portailgestion.ca>",
        to: adminEmails,
        subject: `⚠️ Portail — ${issueList.length} problème(s) détecté(s) par la surveillance système`,
        text: `La vérification automatique de santé du système a détecté ${issueList.length} problème(s) :\n\n${bodyLines}\n\nCette alerte ne se répétera pas avant 2h tant que le problème persiste. Vérifie le tableau de bord admin (section « État du système ») pour plus de détails.`,
      }),
    });

    return new Response(JSON.stringify({ ok: true, notified: adminEmails.length }), { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error("send-health-alert unexpected error", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
