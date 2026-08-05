// L'IA ne choisit ni ne confirme jamais une heure de visite (voir la
// règle stricte dans handle-inquiry.ts) — c'est l'admin qui propose un
// moment via ops-api.ts (action propose_visit) et le candidat répond
// ici via un lien à usage unique protégé par token. "send_reminder" est
// appelé uniquement par le cron send_visit_reminders() (même convention
// que les autres notifications système du projet). Aucune IA ici.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SITE_BASE_URL = "https://portailgestion.ca";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const body = await req.json().catch(() => ({}));
    const { visit_id, token, action, note } = body;
    if (!visit_id || !action) {
      return new Response(JSON.stringify({ error: "Paramètres manquants" }), { status: 400, headers: corsHeaders });
    }

    const visitRes = await fetch(
      `${supabaseUrl}/rest/v1/visits?id=eq.${visit_id}&select=*,units(unit_number,buildings(address))`,
      { headers: adminHeaders },
    );
    const [visit] = await visitRes.json();
    if (!visit) {
      return new Response(JSON.stringify({ error: "Visite introuvable" }), { status: 404, headers: corsHeaders });
    }
    const unit = visit.units;
    const address = unit?.buildings?.address;
    const whenLabel = new Date(visit.proposed_at).toLocaleString("fr-CA", { dateStyle: "full", timeStyle: "short" });

    if (action === "send_reminder") {
      const confirmUrl = `${SITE_BASE_URL}/confirmer-visite.html?visit=${visit_id}&token=${visit.confirmation_token}`;
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Portail <onboarding@resend.dev>",
          to: [visit.prospect_email],
          subject: `Rappel — ta visite de demain`,
          text: `Bonjour ${visit.prospect_name},\n\nPetit rappel pour ta visite prévue :\n${address || ""}, unité ${unit?.unit_number || ""}\n${whenLabel}\n\nUn empêchement ? Avise-nous ici : ${confirmUrl}\n\nL'équipe Portail`,
        }),
      });
      await fetch(`${supabaseUrl}/rest/v1/visits?id=eq.${visit_id}`, {
        method: "PATCH", headers: adminHeaders, body: JSON.stringify({ reminder_sent_at: new Date().toISOString() }),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    // Actions publiques — protégées par le token à usage unique.
    if (!token || visit.confirmation_token !== token) {
      return new Response(JSON.stringify({ error: "Lien invalide ou expiré" }), { status: 403, headers: corsHeaders });
    }

    if (action === "get") {
      return new Response(JSON.stringify({
        prospect_name: visit.prospect_name,
        address,
        unit_number: unit?.unit_number,
        proposed_at: visit.proposed_at,
        status: visit.status,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (visit.status !== "proposed") {
      return new Response(JSON.stringify({ error: "Une réponse a déjà été enregistrée pour cette visite." }), { status: 409, headers: corsHeaders });
    }

    if (action === "confirm") {
      await fetch(`${supabaseUrl}/rest/v1/visits?id=eq.${visit_id}`, {
        method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "confirmed" }),
      });
      await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST", headers: adminHeaders,
        body: JSON.stringify({ actor_type: "system", action: "visit.confirmed", entity_type: "visits", entity_id: visit_id, details: {} }),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "decline") {
      await fetch(`${supabaseUrl}/rest/v1/visits?id=eq.${visit_id}`, {
        method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "declined", response_note: note || null }),
      });
      await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST", headers: adminHeaders,
        body: JSON.stringify({ actor_type: "system", action: "visit.declined", entity_type: "visits", entity_id: visit_id, details: { note: note || null } }),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "propose_other_time") {
      if (!note) {
        return new Response(JSON.stringify({ error: "Précise le moment que tu proposes." }), { status: 400, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/visits?id=eq.${visit_id}`, {
        method: "PATCH", headers: adminHeaders, body: JSON.stringify({ response_note: `Le candidat propose plutôt : ${note}` }),
      });
      await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST", headers: adminHeaders,
        body: JSON.stringify({ actor_type: "system", action: "visit.counter_proposed", entity_type: "visits", entity_id: visit_id, details: { note } }),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    console.error("handle-visit-response unexpected error", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
