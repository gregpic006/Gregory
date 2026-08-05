// Page publique où le travailleur répond (accepter/refuser/proposer
// une heure/demander des infos) — voir edge-function-handle-worker-response.ts
const SITE_BASE_URL = "https://portailgestion.ca";

Deno.serve(async (req) => {
  try {
    const { work_order_id, notification_type } = await req.json();
    const type = notification_type || "assigned";

    const resendKey = Deno.env.get("RESEND_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const woRes = await fetch(
      `${supabaseUrl}/rest/v1/work_orders?id=eq.${work_order_id}&select=*,workers(name,email,specialty,rbq_license),units(unit_number,buildings(address))`,
      { headers: adminHeaders },
    );
    const [workOrder] = await woRes.json();
    if (!workOrder) {
      return new Response(JSON.stringify({ ok: false, error: "work order not found" }), { status: 404 });
    }

    const worker = workOrder.workers;
    const unit = workOrder.units;
    const address = unit?.buildings?.address;

    // Type "all_declined" : plus aucun travailleur disponible n'a
    // accepté — on avise un admin, pas le travailleur.
    if (type === "all_declined") {
      const adminsRes = await fetch(`${supabaseUrl}/rest/v1/users?is_admin=eq.true&select=email`, { headers: adminHeaders });
      const admins = await adminsRes.json().catch(() => []);
      const adminEmails = Array.isArray(admins) ? admins.map((a: any) => a.email).filter(Boolean) : [];
      if (adminEmails.length && resendKey) {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "Portail <onboarding@resend.dev>",
            to: adminEmails,
            subject: `Aucun travailleur disponible — ${address || ""}, unité ${unit?.unit_number || ""}`,
            text: `Aucun travailleur n'a répondu dans les délais pour ce travail (${workOrder.description}) et la liste des travailleurs disponibles est épuisée. Une assignation manuelle est requise dans le portail admin.`,
          }),
        });
      }
      await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ actor_type: "system", action: "work_order.all_workers_declined", entity_type: "work_orders", entity_id: work_order_id, details: {} }),
      });
      return new Response(JSON.stringify({ ok: true, escalated: true }), { status: 200 });
    }

    if (!worker?.email) {
      return new Response(JSON.stringify({ ok: false, error: "no worker email" }), { status: 200 });
    }

    const responseUrl = `${SITE_BASE_URL}/reponse-travailleur.html?wo=${workOrder.id}&token=${workOrder.worker_response_token}`;

    const extraLines: string[] = [];
    if (workOrder.appointment_at) extraLines.push(`Rendez-vous proposé : ${new Date(workOrder.appointment_at).toLocaleString("fr-CA")}`);
    if (workOrder.entry_permission) extraLines.push(`Accès au logement : ${workOrder.entry_permission}`);
    if (workOrder.due_by) extraLines.push(`Échéance : ${workOrder.due_by}`);
    if (workOrder.billing_terms) extraLines.push(`Conditions de facturation : ${workOrder.billing_terms}`);
    if (!worker.rbq_license) extraLines.push(`Note : aucune licence RBQ au dossier — merci de la fournir si applicable.`);

    const subject = type === "reminder"
      ? `Rappel — réponse requise pour un travail assigné`
      : `Nouveau travail assigné — ${address || ""}, unité ${unit?.unit_number || ""}`;

    const introLine = type === "reminder"
      ? `Nous n'avons pas encore reçu ta réponse pour ce travail. Merci de répondre dans les meilleurs délais — si nous restons sans nouvelles, le travail sera réassigné à un autre travailleur.`
      : `Un nouveau travail t'a été assigné.`;

    const bodyText = `${introLine}

Description : ${workOrder.description}
Adresse : ${address || ""} — Unité ${unit?.unit_number || ""}
Paie prévue : ${workOrder.worker_pay != null ? workOrder.worker_pay + " $" : "à confirmer"}
${extraLines.length ? extraLines.join("\n") + "\n" : ""}
Merci de répondre ici (accepter, refuser, proposer une autre heure, ou poser une question) :
${responseUrl}

L'équipe Portail`;

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Portail <onboarding@resend.dev>",
        to: [worker.email],
        subject,
        text: bodyText,
      }),
    });

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    console.error("handle-worker-job-assigned unexpected error", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500 });
  }
});
