Deno.serve(async (req) => {
  try {
    const { payment_id, reminder_type } = await req.json();

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const payRes = await fetch(
      `${supabaseUrl}/rest/v1/payments?id=eq.${payment_id}&select=*,leases(monthly_rent,tenants(full_name,email),units(unit_number,buildings(address)))`,
      { headers: adminHeaders },
    );
    const [payment] = await payRes.json();
    if (!payment) {
      return new Response(JSON.stringify({ ok: false, error: "payment not found" }), { status: 404 });
    }

    const tenant = payment.leases?.tenants;
    const unit = payment.leases?.units;
    const address = unit?.buildings?.address;

    if (!tenant?.email) {
      return new Response(JSON.stringify({ ok: false, error: "no tenant email" }), { status: 200 });
    }

    const prompt = `Tu es l'assistant du service à la clientèle de "Portail", une entreprise de gestion immobilière résidentielle au Québec. Rédige un courriel de rappel de paiement de loyer à un locataire.

Type de rappel: ${reminder_type === "late" ? "Le paiement est EN RETARD (déjà passé la date d'échéance)" : "Le paiement arrive bientôt à échéance (rappel préventif)"}
Nom du locataire: ${tenant.full_name}
Adresse: ${address || ""} — Unité ${unit?.unit_number || ""}
Montant: ${payment.amount} $
Date d'échéance: ${payment.due_date}

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après):
{
  "subject": "un objet de courriel court et professionnel en français",
  "body": "un courriel bref, poli et professionnel en français (3-4 phrases). Si c'est un retard, reste courtois mais clair sur l'importance de régulariser rapidement et d'entrer en contact si besoin. Si c'est préventif, ton simplement informatif et amical. Signé 'L'équipe Portail'."
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
