// Au lieu d'envoyer uniquement les résumés (qui peuvent omettre une
// clause importante), on r'envoie les documents sources pertinents
// eux-mêmes à Claude (comme à l'extraction) et on exige une citation
// (titre du document + page) pour chaque réponse — jamais une
// affirmation non sourcée.
const MAX_DOCS_SENT = 5;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function scoreRelevance(question: string, doc: any): number {
  const words = question.toLowerCase().split(/[^a-zàâäéèêëïîôöùûüç0-9]+/).filter((w) => w.length >= 3);
  const haystack = `${doc.title || ""} ${doc.doc_type || ""} ${doc.ai_summary || ""} ${doc.ai_parties || ""}`.toLowerCase();
  return words.reduce((score, w) => score + (haystack.includes(w) ? 1 : 0), 0);
}

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
      `${supabaseUrl}/rest/v1/documents?owner_id=eq.${owner.id}&select=id,title,doc_type,file_url,ai_summary,ai_parties,ai_key_amount,ai_expiry_date,created_at`,
      { headers: adminHeaders },
    );
    const docs = await docsRes.json();

    if (!Array.isArray(docs) || docs.length === 0) {
      return new Response(JSON.stringify({ answer: "Tu n'as encore aucun document téléversé — je ne peux donc pas répondre à partir de tes documents." }), { status: 200, headers: corsHeaders });
    }

    // Sélection des documents les plus pertinents (mots-clés de la
    // question) ; à défaut de correspondance, les plus récents.
    const scored = docs.map((d: any) => ({ doc: d, score: scoreRelevance(question, d) }));
    const anyMatch = scored.some((s) => s.score > 0);
    const selected = (anyMatch ? scored.filter((s) => s.score > 0) : scored)
      .sort((a, b) => (b.score - a.score) || (new Date(b.doc.created_at).getTime() - new Date(a.doc.created_at).getTime()))
      .slice(0, MAX_DOCS_SENT)
      .map((s) => s.doc);

    const contentParts: any[] = [
      { type: "text", text: `Tu es l'assistant documentaire de "Portail". Voici le profil du propriétaire (plafond de dépenses actuel : ${owner.spending_cap} $, taux de gestion : ${owner.management_rate} %).\n\nTu vas recevoir ${selected.length} document(s) source. Réponds à la question EN CITANT le document et la page exacte d'où vient l'information, dans ce style : "Selon le bail de l'unité 4, page 6, le stationnement numéro 12 est inclus." Ne dis jamais une chose comme "il semble que" sans citer sa source. Si l'information n'est dans aucun document fourni, dis-le clairement plutôt que d'inventer une réponse.` },
    ];

    for (const doc of selected) {
      contentParts.push({ type: "text", text: `--- Document : "${doc.title}" (type déclaré : ${doc.doc_type || "inconnu"}) ---` });

      let added = false;
      if (doc.file_url) {
        try {
          const fileRes = await fetch(`${supabaseUrl}/storage/v1/object/documents/${doc.file_url}`, {
            headers: { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey ?? "" },
          });
          if (fileRes.ok) {
            const contentType = fileRes.headers.get("content-type") || "";
            const bytes = new Uint8Array(await fileRes.arrayBuffer());
            let binary = "";
            const chunkSize = 0x8000;
            for (let i = 0; i < bytes.length; i += chunkSize) {
              binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
            }
            const base64 = btoa(binary);
            if (contentType.includes("pdf")) {
              contentParts.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } });
              added = true;
            } else if (contentType.startsWith("image/")) {
              contentParts.push({ type: "image", source: { type: "base64", media_type: contentType, data: base64 } });
              added = true;
            }
          }
        } catch (e) {
          console.error("Failed to fetch document for Q&A", doc.id, e);
        }
      }

      if (!added) {
        contentParts.push({
          type: "text",
          text: `(Fichier non consultable directement — résumé seulement, sans référence de page fiable) ${doc.ai_summary || "aucun résumé disponible"}. Parties : ${doc.ai_parties || "—"}. Montant clé : ${doc.ai_key_amount ?? "—"}. Échéance : ${doc.ai_expiry_date || "—"}.`,
        });
      }
    }

    contentParts.push({ type: "text", text: `Question du propriétaire : "${question}"\n\nRéponds en français, brièvement, en citant le document et la page pour chaque affirmation factuelle.` });

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
        messages: [{ role: "user", content: contentParts }],
      }),
    });
    const aiData = await aiRes.json();
    if (!aiRes.ok) {
      console.error("Anthropic API error", aiRes.status, JSON.stringify(aiData));
      return new Response(JSON.stringify({ error: "Erreur du service IA, réessaie dans un instant." }), { status: 502, headers: corsHeaders });
    }
    const answer = aiData.content?.[0]?.text ?? "Désolé, je n'ai pas pu générer de réponse.";

    return new Response(JSON.stringify({ answer, sources: selected.map((d: any) => d.title) }), { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error("ask-documents unexpected error", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
