// Envoie le courriel d'une règle d'automatisation (action_type =
// 'envoyer_rappel_email'), déclenché par execute_automation_rules() via
// pg_cron/pg_net — jamais appelé directement par un utilisateur. Le texte
// envoyé est TOUJOURS action_message tel qu'écrit par l'admin à la
// création de la règle : cette fonction ne fait aucune génération IA,
// seulement la résolution du destinataire et l'envoi.
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

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  try {
    const { rule_id, entity_type, entity_id } = await req.json();
    if (!rule_id || !entity_type || !entity_id) {
      return new Response(JSON.stringify({ error: "rule_id, entity_type et entity_id requis" }), { status: 400, headers: corsHeaders });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const ruleRes = await fetch(`${supabaseUrl}/rest/v1/automation_rules?id=eq.${rule_id}&select=name,action_message,action_type`, { headers: adminHeaders });
    const [rule] = await ruleRes.json();
    if (!rule || rule.action_type !== "envoyer_rappel_email" || !rule.action_message) {
      return new Response(JSON.stringify({ error: "Règle introuvable ou sans message configuré" }), { status: 404, headers: corsHeaders });
    }

    let recipientEmail: string | null = null;
    let recipientName = "";
    if (entity_type === "payments") {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/payments?id=eq.${entity_id}&select=leases(tenants(full_name,email))`,
        { headers: adminHeaders },
      );
      const [row] = await res.json();
      recipientEmail = row?.leases?.tenants?.email || null;
      recipientName = row?.leases?.tenants?.full_name || "";
    } else if (entity_type === "leases") {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/leases?id=eq.${entity_id}&select=tenants(full_name,email)`,
        { headers: adminHeaders },
      );
      const [row] = await res.json();
      recipientEmail = row?.tenants?.email || null;
      recipientName = row?.tenants?.full_name || "";
    }

    if (!recipientEmail) {
      return new Response(JSON.stringify({ error: "Aucun courriel de destinataire trouvé" }), { status: 200, headers: corsHeaders });
    }

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Portail <onboarding@mail.portailgestion.ca>",
        to: [recipientEmail],
        subject: rule.name,
        text: `Bonjour ${recipientName},\n\n${rule.action_message}\n\n— L'équipe Portail`,
      }),
    });
    if (!emailRes.ok) {
      console.error("Failed to send automation email", await emailRes.text());
      return new Response(JSON.stringify({ error: "Échec de l'envoi du courriel" }), { status: 502, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error("run-automation-email unexpected error", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
