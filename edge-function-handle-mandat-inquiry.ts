Deno.serve(async (req) => {
  try {
    const { inquiry_id } = await req.json();

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const inqRes = await fetch(`${supabaseUrl}/rest/v1/inquiries?id=eq.${inquiry_id}&select=*`, { headers: adminHeaders });
    const [inquiry] = await inqRes.json();
    if (!inquiry) {
      return new Response(JSON.stringify({ ok: false, error: "inquiry not found" }), { status: 404 });
    }

    // Les champs sont maintenant fournis directement par le
    // formulaire structuré (plus d'extraction IA nécessaire pour
    // ces chiffres — plus fiable). L'IA sert seulement à rédiger un
    // court résumé lisible pour l'équipe commerciale.
    const numDoors = inquiry.num_doors ?? null;
    const avgRent = inquiry.avg_rent ?? null;
    const potentialRevenue = numDoors && avgRent ? Math.round(numDoors * avgRent * 0.06 * 100) / 100 : null;

    const ownershipLabel = inquiry.ownership === "societe" ? "par une société" : inquiry.ownership === "personnel" ? "personnellement" : "non précisé";
    const managementLabel = inquiry.current_management === "sous_gestion" ? "déjà sous gestion" : inquiry.current_management === "autogere" ? "autogéré" : "non précisé";

    const prompt = `Tu es l'assistant CRM de "Portail", une entreprise de gestion immobilière résidentielle au Québec. Rédige un résumé en une phrase pour l'équipe commerciale à partir de cette demande de mandat.

Secteur : ${inquiry.sector || "non précisé"}
Portes : ${numDoors ?? "non précisé"}
Loyer moyen : ${avgRent ?? "non précisé"}
Détenu : ${ownershipLabel}
Situation actuelle : ${managementLabel}
Services recherchés : ${inquiry.services_needed || "non précisé"}
Problème principal : ${inquiry.main_problem || "non précisé"}
Message additionnel : ${inquiry.message || "aucun"}

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après):
{ "summary": "résumé en une phrase" }`;

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const aiData = await aiRes.json();
    const rawText = aiData.content?.[0]?.text ?? "{}";
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    let parsed: any = {};
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = {};
    }

    await fetch(`${supabaseUrl}/rest/v1/prospects`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        inquiry_id,
        full_name: inquiry.full_name,
        email: inquiry.email,
        phone: inquiry.phone,
        num_doors: numDoors,
        avg_rent: avgRent,
        potential_monthly_revenue: potentialRevenue,
        stage: "new",
        notes: parsed.summary ?? inquiry.message ?? null,
        lead_source: "site_web_mandat",
      }),
    });

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500 });
  }
});
