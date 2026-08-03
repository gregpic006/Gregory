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

    const prompt = `Tu es l'assistant CRM de "Portail", une entreprise de gestion immobilière résidentielle au Québec. Un prospect (propriétaire d'immeuble potentiel) a soumis une demande de mandat de gestion. Analyse son message et extrais, si mentionné, le nombre de portes/logements qu'il possède et son loyer moyen approximatif.

Message du prospect: "${inquiry.message || ""}"

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après):
{
  "num_doors": un nombre entier si mentionné/déductible, sinon null,
  "avg_rent": un nombre si un loyer moyen est mentionné/déductible, sinon null,
  "summary": "résumé en une phrase de la demande"
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
        max_tokens: 300,
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

    const numDoors = parsed.num_doors ?? null;
    const avgRent = parsed.avg_rent ?? null;
    const potentialRevenue = numDoors && avgRent ? Math.round(numDoors * avgRent * 0.06 * 100) / 100 : null;

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
      }),
    });

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500 });
  }
});
