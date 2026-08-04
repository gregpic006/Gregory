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
    if (!aiRes.ok) {
      console.error("Anthropic API error", aiRes.status, JSON.stringify(aiData));
      return new Response(JSON.stringify({ ok: false, error: "anthropic_api_error", detail: aiData }), { status: 502 });
    }

    const rawText = aiData.content?.[0]?.text ?? "{}";
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("Failed to parse AI response as JSON", rawText);
      return new Response(JSON.stringify({ ok: false, error: "ai_response_not_json", raw: rawText }), { status: 502 });
    }

    const patchRes = await fetch(`${supabaseUrl}/rest/v1/service_requests?id=eq.${record.id}`, {
      method: "PATCH",
      headers: {
        apikey: serviceRoleKey ?? "",
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        ai_category: parsed.category,
        ai_estimated_cost: parsed.estimated_cost,
        ai_urgency: parsed.urgency,
      }),
    });

    const patchData = await patchRes.json().catch(() => null);
    if (!patchRes.ok || !patchData || patchData.length === 0) {
      console.error("Failed to update service_requests", record.id, patchRes.status, JSON.stringify(patchData));
      return new Response(JSON.stringify({ ok: false, error: "db_update_failed", status: patchRes.status, detail: patchData }), { status: 500 });
    }

    return new Response(JSON.stringify({ ok: true, updated: patchData[0] }), { status: 200 });
  } catch (err) {
    console.error("handle-service-request unexpected error", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500 });
  }
});
