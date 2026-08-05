const MODEL_VERSION = "claude-haiku-4-5-20251001";
const PROMPT_VERSION = "document-extraction-v2-traceability";
const CONFIDENCE_THRESHOLD = 85;

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

    // Empreinte du fichier — sert à détecter les doublons (même contenu
    // téléversé plus d'une fois pour le même propriétaire).
    const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
    const fileHash = Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");

    let duplicateOfId: string | null = null;
    if (doc.owner_id) {
      const dupRes = await fetch(
        `${supabaseUrl}/rest/v1/documents?owner_id=eq.${doc.owner_id}&file_hash=eq.${fileHash}&id=neq.${document_id}&select=id&limit=1`,
        { headers: adminHeaders },
      );
      const dupCandidates = await dupRes.json().catch(() => []);
      duplicateOfId = Array.isArray(dupCandidates) && dupCandidates.length ? dupCandidates[0].id : null;
    }

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
        body: JSON.stringify({
          ai_processed: true,
          ai_summary: "Format de fichier non pris en charge pour l'extraction automatique.",
          ai_needs_human_validation: true,
          file_hash: fileHash,
          is_duplicate_of: duplicateOfId,
        }),
      });
      return new Response(JSON.stringify({ ok: true, skipped: "unsupported file type" }), { status: 200 });
    }

    const aiStartedAt = Date.now();
    const prompt = `Tu es l'assistant documentaire de "Portail", une entreprise de gestion immobilière résidentielle au Québec. Voici un document téléversé (type déclaré : "${doc.doc_type || "non spécifié"}", titre : "${doc.title}"). Analyse-le et extrais les informations clés.

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après):
{
  "summary": "résumé en 1-2 phrases en français de ce que contient le document",
  "parties": "les parties/personnes/entreprises nommées dans le document, séparées par des virgules, ou null",
  "key_amount": un nombre (montant principal en dollars mentionné, sans symbole) ou null,
  "expiry_date": "YYYY-MM-DD si une date d'échéance/expiration/renouvellement est identifiable, sinon null",
  "important_dates": "les autres dates importantes mentionnées, en texte libre, ou null",
  "missing_info": "ce qui semble manquant ou incomplet dans le document, ou null si rien à signaler",
  "confidence": un nombre entre 0 et 100 représentant ta confiance globale dans cette extraction — sois honnête, baisse la confiance si le document est flou, partiel, mal numérisé ou ambigu,
  "source_page": le numéro de page (entier, à partir de 1) où se trouve l'information la plus importante (ex: la date d'échéance), ou null si non applicable,
  "source_excerpt": "un court passage exact tiré du document (une phrase ou moins) qui appuie l'information extraite, ou null si non applicable",
  "readable": true ou false selon si le document est lisible et net,
  "signature_present": true, false, ou null si non applicable pour ce type de document — selon si une signature (manuscrite ou électronique) est visible,
  "doc_type_detected": "le type de document que tu observes réellement (bail, mandat, reglement, facture, rapport, autre) — peut différer du type déclaré ci-dessus"
}`;

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL_VERSION,
        max_tokens: 800,
        messages: [{ role: "user", content: [contentBlock, { type: "text", text: prompt }] }],
      }),
    });

    const aiData = await aiRes.json();
    if (!aiRes.ok) {
      console.error("Anthropic API error", aiRes.status, JSON.stringify(aiData));
      await fetch(`${supabaseUrl}/rest/v1/ai_run_log`, {
        method: "POST", headers: adminHeaders,
        body: JSON.stringify({
          function_name: "handle-document-upload", trigger_source: "edge_function_call", entity_type: "documents", entity_id: document_id,
          prompt_version: PROMPT_VERSION, model_version: MODEL_VERSION, input_summary: doc.title,
          duration_ms: Date.now() - aiStartedAt, error: `anthropic_api_error ${aiRes.status}`,
        }),
      }).catch(() => null);
      return new Response(JSON.stringify({ ok: false, error: "anthropic_api_error", detail: aiData }), { status: 502 });
    }
    const rawText = aiData.content?.[0]?.text ?? "{}";
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    const lowConfidence = typeof parsed.confidence === "number" && parsed.confidence < CONFIDENCE_THRESHOLD;
    const docTypeMismatch = !!(doc.doc_type && parsed.doc_type_detected && doc.doc_type !== parsed.doc_type_detected);
    const needsHumanValidation = !!(lowConfidence || parsed.readable === false || parsed.missing_info || docTypeMismatch || duplicateOfId);

    await fetch(`${supabaseUrl}/rest/v1/ai_run_log`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        function_name: "handle-document-upload",
        trigger_source: "edge_function_call",
        entity_type: "documents",
        entity_id: document_id,
        prompt_version: PROMPT_VERSION,
        model_version: MODEL_VERSION,
        input_summary: doc.title,
        output_summary: parsed.summary ?? null,
        confidence: parsed.confidence ?? null,
        needs_escalation: needsHumanValidation,
        duration_ms: Date.now() - aiStartedAt,
        input_tokens: aiData?.usage?.input_tokens ?? null,
        output_tokens: aiData?.usage?.output_tokens ?? null,
        automatic_action_taken: "extraction_appliquee",
      }),
    }).catch((e) => console.error("Failed to write ai_run_log", e));

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
        ai_confidence: parsed.confidence ?? null,
        ai_source_page: parsed.source_page ?? null,
        ai_source_excerpt: parsed.source_excerpt ?? null,
        ai_model_version: MODEL_VERSION,
        ai_extracted_at: new Date().toISOString(),
        ai_readable: parsed.readable ?? null,
        ai_signature_present: parsed.signature_present ?? null,
        ai_doc_type_detected: parsed.doc_type_detected ?? null,
        ai_needs_human_validation: needsHumanValidation,
        file_hash: fileHash,
        is_duplicate_of: duplicateOfId,
      }),
    });

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    console.error("handle-document-upload unexpected error", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500 });
  }
});
