// Ferme la dernière étape manquante du cycle de réparation : le
// locataire confirme que le travail est bien réglé avant que le
// dossier ne se ferme pour de bon. "get"/"confirm"/"reopen" sont
// publics (protégés par le token à usage unique) ; "send_reminder" est
// appelé uniquement par le cron flag_stuck_repair_cases() (même
// convention que les autres notifications système du projet).
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
    const { work_order_id, token, action, message } = body;
    if (!work_order_id || !action) {
      return new Response(JSON.stringify({ error: "Paramètres manquants" }), { status: 400, headers: corsHeaders });
    }

    const woRes = await fetch(
      `${supabaseUrl}/rest/v1/work_orders?id=eq.${work_order_id}&select=*,units(unit_number,buildings(address)),service_requests(id,tenant_id,tenants(full_name,email))`,
      { headers: adminHeaders },
    );
    const [wo] = await woRes.json();
    if (!wo) {
      return new Response(JSON.stringify({ error: "Travail introuvable" }), { status: 404, headers: corsHeaders });
    }

    const unit = wo.units;
    const address = unit?.buildings?.address;
    const tenant = wo.service_requests?.tenants;
    const serviceRequestId = wo.service_requests?.id;

    if (action === "send_reminder") {
      if (!tenant?.email) {
        return new Response(JSON.stringify({ ok: true, skipped: "no tenant email" }), { status: 200, headers: corsHeaders });
      }
      const confirmUrl = `${SITE_BASE_URL}/confirmer-reparation.html?wo=${work_order_id}&token=${wo.tenant_confirmation_token}`;
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Portail <onboarding@mail.portailgestion.ca>",
          to: [tenant.email],
          subject: `Rappel — confirme que ta réparation est bien réglée`,
          text: `Bonjour ${tenant.full_name},\n\nOn n'a pas encore eu de nouvelles au sujet de cette réparation (${address || ""}, unité ${unit?.unit_number || ""}) :\n${wo.description}\n\nMerci de confirmer ici que tout est réglé, ou de nous dire si ce n'est pas le cas : ${confirmUrl}\n\nL'équipe Portail`,
        }),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    // Actions publiques — protégées par le token à usage unique.
    if (!token || wo.tenant_confirmation_token !== token) {
      return new Response(JSON.stringify({ error: "Lien invalide ou expiré" }), { status: 403, headers: corsHeaders });
    }

    if (action === "get") {
      return new Response(JSON.stringify({
        description: wo.description,
        address,
        unit_number: unit?.unit_number,
        tenant_confirmed: wo.tenant_confirmed,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (wo.tenant_confirmed === true || wo.tenant_confirmed === false) {
      return new Response(JSON.stringify({ error: "Une réponse a déjà été enregistrée pour ce travail." }), { status: 409, headers: corsHeaders });
    }

    if (action === "confirm") {
      await fetch(`${supabaseUrl}/rest/v1/work_orders?id=eq.${work_order_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ tenant_confirmed: true }),
      });
      if (serviceRequestId) {
        await fetch(`${supabaseUrl}/rest/v1/service_requests?id=eq.${serviceRequestId}`, {
          method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "closed" }),
        });
      }
      await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST", headers: adminHeaders,
        body: JSON.stringify({ actor_type: "system", action: "repair_case.tenant_confirmed", entity_type: "work_orders", entity_id: work_order_id, details: {} }),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "reopen") {
      await fetch(`${supabaseUrl}/rest/v1/work_orders?id=eq.${work_order_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ tenant_confirmed: false, tenant_confirmation_note: message || null }),
      });
      if (serviceRequestId) {
        await fetch(`${supabaseUrl}/rest/v1/service_requests?id=eq.${serviceRequestId}`, {
          method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "open" }),
        });
      }

      try {
        const adminsRes = await fetch(`${supabaseUrl}/rest/v1/users?is_admin=eq.true&select=email`, { headers: adminHeaders });
        const admins = await adminsRes.json().catch(() => []);
        const adminEmails = Array.isArray(admins) ? admins.map((a: any) => a.email).filter(Boolean) : [];
        if (adminEmails.length && resendKey) {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: "Portail <onboarding@mail.portailgestion.ca>",
              to: adminEmails,
              subject: `Le locataire signale que le problème persiste — ${address || ""}, unité ${unit?.unit_number || ""}`,
              text: `${tenant?.full_name || "Le locataire"} indique que la réparation suivante n'est pas réglée :\n${wo.description}\n\nMessage du locataire : ${message || "(aucun message)"}\n\nLa demande a été rouverte dans la file des demandes de service.`,
            }),
          });
        }
      } catch (e) {
        console.error("Failed to notify admins of reopened repair case", e);
      }

      await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST", headers: adminHeaders,
        body: JSON.stringify({ actor_type: "system", action: "repair_case.tenant_reopened", entity_type: "work_orders", entity_id: work_order_id, details: { message: message || null } }),
      });

      const tenantId = wo.service_requests?.tenant_id;
      if (message && tenantId) {
        fetch(`${supabaseUrl}/functions/v1/analyze-satisfaction-signal`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: "sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR" },
          body: JSON.stringify({
            source: "repair_reopened", subject_type: "tenant", subject_id: tenantId,
            related_entity_type: "work_orders", related_entity_id: work_order_id, content: message,
          }),
        }).catch((e) => console.error("Failed to trigger satisfaction analysis", e));
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    console.error("handle-tenant-confirmation unexpected error", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
