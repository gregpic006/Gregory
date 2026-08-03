Deno.serve(async (req) => {
  try {
    const { document_id } = await req.json();

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const docRes = await fetch(`${supabaseUrl}/rest/v1/documents?id=eq.${document_id}&select=*`, { headers: adminHeaders });
    const [doc] = await docRes.json();
    if (!doc || !doc.file_url) {
      return new Response(JSON.stringify({ ok: false, error: "document introuvable ou sans fichier" }), { status: 200 });
    }

    const fileRes = await fetch(`${supabaseUrl}/storage/v1/object/documents/${doc.file_url}`, {
      headers: { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey ?? "" },
    });
    if (!fileRes.ok) {
      return new Response(JSON.stringify({ ok: false, error: "téléchargement du fichier impossible" }), { status: 200 });
    }
    const contentType = fileRes.headers.get("content-type") || "";
    const bytes = new Uint8Array(await fileRes.arrayBuffer());
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    const base64 = btoa(binary);

    let contentBlock: Record<string, unknown> | null = null;
    if (contentType.includes("pdf")) {
      contentBlock = { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } };
    } else if (contentType.startsWith("image/")) {
      contentBlock = { type: "image", source: { type: "base64", media_type: contentType, data: base64 } };
    }

    if (!contentBlock) {
      await fetch(`${supabaseUrl}/rest/v1/documents?id=eq.${document_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ ai_processed: true, ai_summary: "Format de fichier non pris en charge pour l'extraction automatique." }),
      });
      return new Response(JSON.stringify({ ok: true, skipped: "unsupported file type" }), { status: 200 });
    }

    const prompt = `Tu es l'assistant documentaire de "Portail", une entreprise de gestion immobilière résidentielle au Québec. Voici un document téléversé (type déclaré : "${doc.doc_type || "non spécifié"}", titre : "${doc.title}"). Analyse-le et extrais les informations clés.

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après):
{
  "summary": "résumé en 1-2 phrases en français de ce que contient le document",
  "parties": "les parties/personnes/entreprises nommées dans le document, séparées par des virgules, ou null",
  "key_amount": un nombre (montant principal en dollars mentionné, sans symbole) ou null,
  "expiry_date": "YYYY-MM-DD si une date d'échéance/expiration/renouvellement est identifiable, sinon null",
  "important_dates": "les autres dates importantes mentionnées, en texte libre, ou null",
  "missing_info": "ce qui semble manquant ou incomplet dans le document, ou null si rien à signaler"
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
        messages: [{ role: "user", content: [contentBlock, { type: "text", text: prompt }] }],
      }),
    });

    const aiData = await aiRes.json();
    const rawText = aiData.content?.[0]?.text ?? "{}";
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    await fetch(`${supabaseUrl}/rest/v1/documents?id=eq.${document_id}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({
        ai_processed: true,
        ai_summary: parsed.summary ?? null,
        ai_parties: parsed.parties ?? null,
        ai_key_amount: parsed.key_amount ?? null,
        ai_expiry_date: parsed.expiry_date ?? null,
        ai_extracted: parsed,
      }),
    });

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500 });
  }
});
