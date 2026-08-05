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

    // Garde-fou : si le logement est "soon_available" mais qu'un bail
    // actif s'étend encore loin dans le futur, ceci ressemble davantage
    // à une tentative d'augmentation de loyer sur bail existant qu'à une
    // vraie vacance à venir. Le TAL impose une méthode de calcul
    // réglementée pour une augmentation — jamais une comparaison de
    // marché. On refuse alors de suggérer un montant.
    if (unit.status === "soon_available") {
      const leaseRes = await fetch(
        `${supabaseUrl}/rest/v1/leases?unit_id=eq.${unit_id}&status=eq.active&select=end_date&order=end_date.asc&limit=1`,
        { headers: adminHeaders },
      );
      const [activeLease] = await leaseRes.json().catch(() => [null]);
      if (activeLease?.end_date) {
        const daysUntilEnd = Math.round((new Date(activeLease.end_date).getTime() - Date.now()) / 86400000);
        if (daysUntilEnd > 45) {
          await fetch(`${supabaseUrl}/rest/v1/units?id=eq.${unit_id}`, {
            method: "PATCH",
            headers: adminHeaders,
            body: JSON.stringify({
              suggested_rent: null,
              listing_description: null,
              listing_quality_notes: "Bail actif encore loin de son échéance (plus de 45 jours) — aucune annonce ni suggestion de loyer basée sur le marché n'a été générée. Une augmentation de loyer sur un bail existant doit suivre le calcul réglementé du Tribunal administratif du logement (TAL), jamais une comparaison avec le marché.",
            }),
          });
          return new Response(JSON.stringify({ ok: true, guard_triggered: "active_lease_far_from_end" }), { status: 200 });
        }
      }
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

    const prompt = `Tu es l'assistant de location de "Portail", une entreprise de gestion immobilière résidentielle au Québec. Rédige une annonce de location en français pour ce logement VACANT (nouveau bail, pas un renouvellement — les comparables de marché sont donc appropriés ici).

Type de logement: ${unit.unit_type || "non spécifié"}
Adresse: ${unit.buildings?.address || ""}
Loyer demandé actuel: ${unit.rent != null ? unit.rent + " $/mois" : "non fixé"}
Caractéristiques/équipements fournis par le propriétaire: ${unit.amenities || "aucun détail fourni"}
Loyer moyen des logements comparables occupés dans le portefeuille (même type): ${avgRent != null ? avgRent + " $/mois" : "aucune donnée comparable"}

RÈGLES STRICTES :
- N'invente aucun équipement, caractéristique ou detail qui n'est pas explicitement fourni ci-dessus.
- N'utilise JAMAIS de formulation discriminatoire ou qui pourrait exclure des candidats selon des motifs protégés (race, couleur, sexe, grossesse, orientation sexuelle, état civil, âge, religion, origine ethnique ou nationale, condition sociale, handicap, situation familiale). Exemples à éviter : "idéal pour jeune professionnel", "sans enfants", "couple sans animaux préféré". Décris le logement, jamais le locataire recherché.
- Adapte "description" pour le site Portail (3-5 phrases) et "description_short" pour une plateforme à format court comme Marketplace (350 caractères maximum, aucune coupure de mot).

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après):
{
  "description": "annonce complète pour le site, factuelle et attrayante",
  "description_short": "version courte (350 caractères max) pour Marketplace/réseaux sociaux",
  "suggested_rent": un nombre représentant un loyer suggéré basé sur les comparables (ou null si aucune donnée comparable disponible),
  "quality_score": un nombre entre 0 et 100 évaluant la qualité/attractivité de cette annonce compte tenu des informations disponibles (baisse le score si peu de détails sont fournis),
  "quality_notes": "une phrase expliquant ce qui limite la qualité de l'annonce ou comment l'améliorer (ex: 'ajouter des photos et le nombre de pièces d'eau'), ou null si rien à signaler",
  "discriminatory_language_removed": true ou false selon si tu as dû retirer une formulation discriminatoire du brouillon initial en rédigeant"
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
        max_tokens: 700,
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
    const parsed = JSON.parse(cleaned);

    await fetch(`${supabaseUrl}/rest/v1/units?id=eq.${unit_id}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({
        listing_description: parsed.description ?? null,
        listing_description_short: parsed.description_short ?? null,
        suggested_rent: parsed.suggested_rent ?? avgRent,
        listing_quality_score: parsed.quality_score ?? null,
        listing_quality_notes: parsed.quality_notes ?? null,
      }),
    });

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    console.error("generate-listing unexpected error", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500 });
  }
});
