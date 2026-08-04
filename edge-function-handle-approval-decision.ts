Deno.serve(async (req) => {
  try {
    const { approval_id, decision } = await req.json();

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const apRes = await fetch(
      `${supabaseUrl}/rest/v1/approvals?id=eq.${approval_id}&select=*,work_orders(description,worker_pay,units(unit_number,buildings(address)),service_requests(tenant_id,tenants(full_name,email)))`,
      { headers: adminHeaders },
    );
    const [approval] = await apRes.json();
    if (!approval) {
      return new Response(JSON.stringify({ ok: false, error: "approval not found" }), { status: 404 });
    }

    const workOrder = approval.work_orders;
    const unit = workOrder?.units;
    const address = unit?.buildings?.address;
    const tenant = workOrder?.service_requests?.tenants;

    if (!tenant?.email) {
      return new Response(JSON.stringify({ ok: false, error: "no tenant email" }), { status: 200 });
    }

    const prompt = `Tu es l'assistant du service à la clientèle de "Portail", une entreprise de gestion immobilière résidentielle au Québec. Un propriétaire vient de prendre une décision au sujet d'une réparation demandée par un locataire. Rédige un courriel informant le locataire du résultat.

Décision: ${decision === "approved" ? "APPROUVÉE — les travaux sont autorisés et seront planifiés" : "REFUSÉE — le propriétaire n'autorise pas cette dépense pour l'instant, une alternative sera étudiée"}
Nom du locataire: ${tenant.full_name}
Adresse: ${address || ""} — Unité ${unit?.unit_number || ""}
Description des travaux demandés: ${workOrder?.description || ""}

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après):
{
  "subject": "un objet de courriel court et professionnel en français",
  "body": "un courriel bref, poli et professionnel en français (3-4 phrases) informant le locataire de la décision et des prochaines étapes. Si refusée, reste rassurant et mentionne qu'une solution alternative sera proposée sous peu. Signé 'L'équipe Portail'."
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
        to: [tenant.email],
        subject: parsed.subject,
        text: parsed.body,
      }),
    });

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500 });
  }
});
