Deno.serve(async (req) => {
  try {
    const { work_order_id } = await req.json();

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const woRes = await fetch(
      `${supabaseUrl}/rest/v1/work_orders?id=eq.${work_order_id}&select=*,workers(name,email,specialty),units(unit_number,buildings(address))`,
      { headers: adminHeaders },
    );
    const [workOrder] = await woRes.json();
    if (!workOrder) {
      return new Response(JSON.stringify({ ok: false, error: "work order not found" }), { status: 404 });
    }

    const worker = workOrder.workers;
    const unit = workOrder.units;
    const address = unit?.buildings?.address;

    if (!worker?.email) {
      return new Response(JSON.stringify({ ok: false, error: "no worker email" }), { status: 200 });
    }

    const prompt = `Tu es l'assistant de coordination de "Portail", une entreprise de gestion immobilière résidentielle au Québec. Rédige un courriel informant un travailleur autonome (sous-traitant) qu'un nouveau travail lui a été assigné.

Nom du travailleur: ${worker.name}
Spécialité: ${worker.specialty || "non spécifiée"}
Adresse du travail: ${address || ""} — Unité ${unit?.unit_number || ""}
Description du travail: ${workOrder.description}
Paie prévue pour ce travail: ${workOrder.worker_pay != null ? workOrder.worker_pay + " $" : "à confirmer"}

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après):
{
  "subject": "un objet de courriel court et professionnel en français mentionnant une nouvelle assignation",
  "body": "un courriel bref, clair et professionnel en français (3-5 phrases) qui confirme l'assignation, résume le travail à faire, l'adresse, et la paie prévue. Demande de confirmer sa disponibilité. Signé 'L'équipe Portail'."
}`;

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const aiData = await aiRes.json();
    const rawText = aiData.content?.[0]?.text ?? "{}";
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Portail <onboarding@resend.dev>",
        to: [worker.email],
        subject: parsed.subject,
        text: parsed.body,
      }),
    });

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500 });
  }
});
