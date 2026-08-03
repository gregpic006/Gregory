Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    const record = payload.record;

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    const prompt = `Tu es l'assistant technique d'une entreprise de gestion immobilière résidentielle au Québec. Un locataire vient de soumettre une demande de service pour son logement.

Description du problème: ${record.description}

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après), avec exactement ces champs:
{
  "category": "la catégorie du problème parmi: Plomberie, Électricité, CVC (chauffage/climatisation), Électroménager, Structure/menuiserie, Autre",
  "estimated_cost": un nombre représentant une estimation préliminaire du coût de réparation en dollars canadiens, basée sur les tarifs typiques au Québec pour ce genre de problème (pas de texte, juste le nombre),
  "urgency": "le niveau d'urgence parmi: faible, normal, élevé, urgence"
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

    await fetch(`${supabaseUrl}/rest/v1/service_requests?id=eq.${record.id}`, {
      method: "PATCH",
      headers: {
        apikey: serviceRoleKey ?? "",
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        ai_category: parsed.category,
        ai_estimated_cost: parsed.estimated_cost,
        ai_urgency: parsed.urgency,
      }),
    });

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500 });
  }
});
