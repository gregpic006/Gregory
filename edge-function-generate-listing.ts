Deno.serve(async (req) => {
  try {
    const { unit_id } = await req.json();

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const unitRes = await fetch(
      `${supabaseUrl}/rest/v1/units?id=eq.${unit_id}&select=*,buildings(address,owner_id)`,
      { headers: adminHeaders },
    );
    const [unit] = await unitRes.json();
    if (!unit) {
      return new Response(JSON.stringify({ ok: false, error: "unit not found" }), { status: 404 });
    }

    const ownerId = unit.buildings?.owner_id;
    let avgRent: number | null = null;
    if (ownerId) {
      const buildingsRes = await fetch(
        `${supabaseUrl}/rest/v1/buildings?owner_id=eq.${ownerId}&select=id`,
        { headers: adminHeaders },
      );
      const buildings = await buildingsRes.json();
      const bIds = buildings.map((b: any) => b.id);
      if (bIds.length && unit.unit_type) {
        const compRes = await fetch(
          `${supabaseUrl}/rest/v1/units?building_id=in.(${bIds.join(",")})&unit_type=eq.${encodeURIComponent(unit.unit_type)}&status=eq.occupied&select=rent`,
          { headers: adminHeaders },
        );
        const comps = await compRes.json();
        if (comps.length) {
          avgRent = Math.round((comps.reduce((s: number, c: any) => s + Number(c.rent || 0), 0) / comps.length) * 100) / 100;
        }
      }
    }

    const prompt = `Tu es l'assistant de location de "Portail", une entreprise de gestion immobilière résidentielle au Québec. Rédige une courte annonce de location en français pour ce logement.

Type de logement: ${unit.unit_type || "non spécifié"}
Adresse: ${unit.buildings?.address || ""}
Loyer demandé actuel: ${unit.rent != null ? unit.rent + " $/mois" : "non fixé"}
Loyer moyen des logements comparables occupés dans le portefeuille (même type): ${avgRent != null ? avgRent + " $/mois" : "aucune donnée comparable"}

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après):
{
  "description": "une annonce attrayante mais factuelle en français, 2-4 phrases, sans inventer d'équipements ou de détails non fournis",
  "suggested_rent": un nombre représentant un loyer suggéré basé sur les comparables (ou null si aucune donnée comparable disponible)
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
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const aiData = await aiRes.json();
    const rawText = aiData.content?.[0]?.text ?? "{}";
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    await fetch(`${supabaseUrl}/rest/v1/units?id=eq.${unit_id}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({
        listing_description: parsed.description ?? null,
        suggested_rent: parsed.suggested_rent ?? avgRent,
      }),
    });

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500 });
  }
});
