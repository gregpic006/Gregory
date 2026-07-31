Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    const record = payload.record;

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    const prompt = `Tu es l'assistant du service à la clientèle de "Portail", une entreprise de gestion immobilière résidentielle au Québec. Un formulaire a été soumis sur le site public.

Type de demande: ${record.type === "visite" ? "Demande de visite pour un logement" : "Propriétaire souhaitant confier son immeuble en gestion"}
Nom: ${record.full_name}
Courriel: ${record.email}
Téléphone: ${record.phone || "non fourni"}
Message: ${record.message || "(aucun message)"}

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après), avec exactement ces champs:
{
  "category": "une courte étiquette de catégorisation en français",
  "summary": "un résumé en 1-2 phrases en français, à l'intention du gestionnaire",
  "reply_subject": "un objet de courriel court et professionnel en français",
  "reply_body": "un courriel de réponse chaleureux, professionnel et concis en français (3-5 phrases), qui confirme la réception de la demande, indique qu'un membre de l'équipe la contactera bientôt, et est signé 'L'équipe Portail'"
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
        max_tokens: 1024,
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
        to: [record.email],
        subject: parsed.reply_subject,
        text: parsed.reply_body,
      }),
    });

    await fetch(`${supabaseUrl}/rest/v1/inquiries?id=eq.${record.id}`, {
      method: "PATCH",
      headers: {
        apikey: serviceRoleKey ?? "",
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        ai_category: parsed.category,
        ai_summary: parsed.summary,
        ai_reply_sent: true,
      }),
    });

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500 });
  }
});
