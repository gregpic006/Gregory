const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  try {
    const { question } = await req.json();
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), { status: 401, headers: corsHeaders });
    }
    const payloadBase64 = jwt.split(".")[1];
    const claims = JSON.parse(atob(payloadBase64.replace(/-/g, "+").replace(/_/g, "/")));
    const userId = claims.sub;

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const ownerRes = await fetch(
      `${supabaseUrl}/rest/v1/owners?user_id=eq.${userId}&select=id,spending_cap,management_rate`,
      { headers: adminHeaders },
    );
    const [owner] = await ownerRes.json();
    if (!owner) {
      return new Response(JSON.stringify({ error: "Aucun profil propriétaire associé à ce compte" }), { status: 403, headers: corsHeaders });
    }

    const docsRes = await fetch(
      `${supabaseUrl}/rest/v1/documents?owner_id=eq.${owner.id}&select=title,doc_type,ai_summary,ai_parties,ai_key_amount,ai_expiry_date`,
      { headers: adminHeaders },
    );
    const docs = await docsRes.json();

    const context = docs.length
      ? docs.map((d: any) =>
          `- "${d.title}" (type: ${d.doc_type || "inconnu"}): ${d.ai_summary || "pas encore analysé"}. Parties: ${d.ai_parties || "—"}. Montant clé: ${d.ai_key_amount ?? "—"}. Échéance: ${d.ai_expiry_date || "—"}.`
        ).join("\n")
      : "Aucun document téléversé pour l'instant.";

    const prompt = `Tu es l'assistant documentaire de "Portail". Voici ce qu'on sait du propriétaire qui pose la question (plafond de dépenses actuel : ${owner.spending_cap} $, taux de gestion : ${owner.management_rate} %) ainsi que ses documents connus :

${context}

Question du propriétaire : "${question}"

Réponds en français, brièvement et directement, en te basant uniquement sur les informations ci-dessus. Si l'information n'est pas disponible, dis-le clairement plutôt que d'inventer une réponse.`;

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
    const answer = aiData.content?.[0]?.text ?? "Désolé, je n'ai pas pu générer de réponse.";

    return new Response(JSON.stringify({ answer }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
