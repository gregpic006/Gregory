// Portail Finance — lecture IA d'une facture/reçu fournisseur.
// Flux en DEUX temps, jamais un seul : "parse" ne fait AUCUNE écriture
// dans expenses — elle téléverse le fichier, l'analyse et retourne les
// champs proposés (fournisseur, montant, taxes, catégorie, immeuble
// probable). "confirm" est l'action qui crée réellement la dépense, et
// exige toujours un building_id — même quand la confiance de l'IA est
// haute, la création de l'écriture comptable reste un geste explicite
// de l'admin (même principe que le reste du projet : l'IA propose,
// jamais n'exécute seule un geste financier). Reprend exactement le
// même modèle IA (Claude, mêmes champs de journalisation ai_run_log)
// que handle-document-upload.ts, pour rester cohérent avec le seul
// autre pipeline d'extraction documentaire du projet.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MODEL_VERSION = "claude-haiku-4-5-20251001";
const PROMPT_VERSION = "expense-receipt-extraction-v1";
const CONFIDENCE_THRESHOLD = 85;
const ALLOWED_CATEGORIES = [
  "plomberie", "electricite", "cvac", "serrurerie", "structure", "peinture", "menage",
  "assurance", "taxes_municipales", "utilities", "administratif", "autre",
];

// Vérifie la signature du JWT (HS256, secret du projet Supabase) au lieu
// de se fier uniquement au réglage "Verify JWT" de la plateforme —
// défense en profondeur : cette fonction reste sûre même si ce réglage
// est mal configuré pour une fonction en particulier.
async function verifySupabaseJwt(jwt: string, jwtSecret: string, supabaseUrl: string): Promise<{ sub: string; [key: string]: unknown } | null> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  try {
    const header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(headerB64)));
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = base64UrlToBytes(signatureB64);

    let valid = false;
    if (header.alg === "HS256") {
      if (!jwtSecret) return null;
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(jwtSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      valid = await crypto.subtle.verify("HMAC", key, signature, signingInput);
    } else if (header.alg === "ES256") {
      // Supabase signe désormais les nouveaux JWT avec une clé
      // asymétrique ECC (P-256) par défaut — on vérifie via la clé
      // publique exposée sur /auth/v1/jwks plutôt qu'un secret partagé.
      // Le HS256 ci-dessus reste supporté pour les projets encore sur
      // l'ancien secret JWT legacy (les deux peuvent coexister pendant
      // une migration Supabase).
      const jwks = await getSupabaseJwks(supabaseUrl);
      const jwk = jwks.keys.find((k: any) => k.kid === header.kid && k.kty === "EC");
      if (!jwk) return null;
      const publicKey = await crypto.subtle.importKey(
        "jwk",
        { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, signingInput);
    } else {
      return null;
    }

    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadB64)));
    if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// Cache en mémoire du trousseau de clés publiques (JWKS) du projet —
// évite un appel réseau à chaque requête ; réutilisé tant que l'instance
// de la fonction edge reste "chaude", et rafraîchi après 10 minutes pour
// suivre une éventuelle rotation de clé côté Supabase.
let cachedJwks: { keys: any[] } | null = null;
let cachedJwksAt = 0;
async function getSupabaseJwks(supabaseUrl: string): Promise<{ keys: any[] }> {
  const now = Date.now();
  if (cachedJwks && now - cachedJwksAt < 10 * 60 * 1000) return cachedJwks;
  const res = await fetch(`${supabaseUrl}/auth/v1/jwks`);
  const data = await res.json().catch(() => ({ keys: [] }));
  cachedJwks = { keys: Array.isArray(data?.keys) ? data.keys : [] };
  cachedJwksAt = now;
  return cachedJwks;
}

function base64UrlToBytes(b64url: string): Uint8Array {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  try {
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), { status: 401, headers: corsHeaders });
    }
    const jwtSecret = Deno.env.get("SUPABASE_JWT_SECRET") ?? "";
    const claims = await verifySupabaseJwt(jwt, jwtSecret, Deno.env.get("SUPABASE_URL") ?? "");
    if (!claims) {
      return new Response(JSON.stringify({ error: "Jeton invalide ou expiré" }), { status: 401, headers: corsHeaders });
    }
    const userId = claims.sub as string;

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const userRes = await fetch(`${supabaseUrl}/rest/v1/users?id=eq.${userId}&select=is_admin`, { headers: adminHeaders });
    const [userRow] = await userRes.json().catch(() => [null]);
    if (!userRow?.is_admin) {
      return new Response(JSON.stringify({ error: "Accès refusé — compte non admin" }), { status: 403, headers: corsHeaders });
    }

    const logAudit = (action: string, entityType: string, entityId: string | null, details: Record<string, unknown>) =>
      fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST", headers: adminHeaders,
        body: JSON.stringify({ actor_type: "admin", actor_id: userId, action, entity_type: entityType, entity_id: entityId, details }),
      });

    const body = await req.json().catch(() => ({}));
    const action = body.action || "parse";

    if (action === "parse") {
      const { file_base64, filename, content_type, building_id } = body;
      if (!file_base64 || !content_type) {
        return new Response(JSON.stringify({ error: "Fichier manquant" }), { status: 400, headers: corsHeaders });
      }
      if (!content_type.includes("pdf") && !content_type.startsWith("image/")) {
        return new Response(JSON.stringify({ error: "Format non pris en charge — PDF ou image seulement" }), { status: 400, headers: corsHeaders });
      }

      const path = `expenses/${Date.now()}-${(filename || "facture").replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
      const bytes = Uint8Array.from(atob(file_base64), (c) => c.charCodeAt(0));
      const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/documents/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey ?? "", "Content-Type": content_type },
        body: bytes,
      });
      if (!uploadRes.ok) {
        return new Response(JSON.stringify({ error: "Échec du téléversement" }), { status: 500, headers: corsHeaders });
      }

      const docRes = await fetch(`${supabaseUrl}/rest/v1/documents`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "return=representation" },
        body: JSON.stringify({ title: filename || "Facture fournisseur", doc_type: "facture", file_url: path, building_id: building_id || null }),
      });
      const [doc] = await docRes.json().catch(() => [null]);
      if (!doc?.id) {
        return new Response(JSON.stringify({ error: "Impossible d'enregistrer le document" }), { status: 500, headers: corsHeaders });
      }

      // Liste des immeubles pour aider l'IA à faire correspondre une
      // adresse lisible sur la facture à un immeuble existant — sans ça,
      // elle ne peut que deviner un nom en texte libre inexploitable.
      const buildingsRes = await fetch(`${supabaseUrl}/rest/v1/buildings?select=id,address&order=address.asc`, { headers: adminHeaders });
      const buildings = await buildingsRes.json().catch(() => []);
      const buildingsList = (Array.isArray(buildings) ? buildings : []).map((b: any) => `${b.id} :: ${b.address}`).join("\n");

      const contentBlock = content_type.includes("pdf")
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: file_base64 } }
        : { type: "image", source: { type: "base64", media_type: content_type, data: file_base64 } };

      const prompt = `Tu es l'assistant comptable de "Portail", une entreprise de gestion immobilière résidentielle au Québec. Voici une facture ou un reçu de fournisseur téléversé par un admin. Analyse-le et extrais les informations pour préparer une écriture de dépense.

Liste des immeubles gérés (id :: adresse), pour tenter une correspondance si une adresse est visible sur la facture :
${buildingsList || "(aucun immeuble enregistré)"}

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après) :
{
  "vendor_name": "nom du fournisseur/entreprise émettrice, ou null",
  "invoice_date": "YYYY-MM-DD si une date de facture est identifiable, sinon null",
  "amount_before_tax": nombre (montant avant taxes) ou null,
  "gst_amount": nombre (TPS) ou null si absente/non applicable,
  "qst_amount": nombre (TVQ) ou null si absente/non applicable,
  "total_amount": nombre (montant total à payer, taxes incluses) — c'est le champ le plus important, ne jamais le laisser null si un montant est visible,
  "category": une seule valeur parmi ${JSON.stringify(ALLOWED_CATEGORIES)},
  "description": "description courte en français de la nature de la dépense (ex: 'Réparation robinet cuisine', 'Facture Hydro-Québec juillet')",
  "matched_building_id": "l'id exact d'un immeuble de la liste ci-dessus si l'adresse sur la facture correspond clairement à l'un d'eux, sinon null — ne jamais inventer un id qui n'est pas dans la liste",
  "confidence": un nombre entre 0 et 100 représentant ta confiance globale — baisse-la si la facture est floue, partielle, mal numérisée, ou si le montant total est ambigu,
  "readable": true ou false selon si le document est lisible et net
}`;

      const aiStartedAt = Date.now();
      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": anthropicKey ?? "", "anthropic-version": "2023-06-01", "content-type": "application/json" },
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
            function_name: "parse-expense-receipt", trigger_source: "edge_function_call", entity_type: "documents", entity_id: doc.id,
            prompt_version: PROMPT_VERSION, model_version: MODEL_VERSION, input_summary: filename || "facture",
            duration_ms: Date.now() - aiStartedAt, error: `anthropic_api_error ${aiRes.status}`,
          }),
        }).catch(() => null);
        return new Response(JSON.stringify({ error: "Échec de l'analyse IA", document_id: doc.id }), { status: 502, headers: corsHeaders });
      }

      const rawText = aiData.content?.[0]?.text ?? "{}";
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
      } catch {
        parsed = { confidence: 0, readable: false };
      }
      if (!ALLOWED_CATEGORIES.includes(parsed.category as string)) parsed.category = "autre";

      const matchedBuildingId = buildings.some((b: any) => b.id === parsed.matched_building_id) ? parsed.matched_building_id : (building_id || null);
      const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
      const needsReview = confidence < CONFIDENCE_THRESHOLD || parsed.readable === false || parsed.total_amount == null || !matchedBuildingId;

      await fetch(`${supabaseUrl}/rest/v1/ai_run_log`, {
        method: "POST", headers: adminHeaders,
        body: JSON.stringify({
          function_name: "parse-expense-receipt", trigger_source: "edge_function_call", entity_type: "documents", entity_id: doc.id,
          prompt_version: PROMPT_VERSION, model_version: MODEL_VERSION, input_summary: filename || "facture",
          output_summary: parsed.description ?? null, confidence, needs_escalation: needsReview,
          duration_ms: Date.now() - aiStartedAt, input_tokens: aiData?.usage?.input_tokens ?? null, output_tokens: aiData?.usage?.output_tokens ?? null,
          automatic_action_taken: "extraction_proposee_en_attente_de_confirmation",
        }),
      }).catch((e) => console.error("Failed to write ai_run_log", e));

      await fetch(`${supabaseUrl}/rest/v1/documents?id=eq.${doc.id}`, {
        method: "PATCH", headers: adminHeaders,
        body: JSON.stringify({
          ai_processed: true, ai_extracted: parsed, ai_confidence: confidence,
          ai_model_version: MODEL_VERSION, ai_extracted_at: new Date().toISOString(),
          ai_readable: parsed.readable ?? null, ai_needs_human_validation: needsReview,
        }),
      });

      return new Response(JSON.stringify({
        ok: true, document_id: doc.id, parsed, confidence, needs_review: needsReview,
        matched_building_id: matchedBuildingId,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "confirm") {
      const { document_id, building_id, unit_id, description, vendor_name, category, total_amount, gst_amount, qst_amount, expense_date } = body;
      if (!building_id || !description || total_amount == null) {
        return new Response(JSON.stringify({ error: "Immeuble, description et montant total requis" }), { status: 400, headers: corsHeaders });
      }
      const expenseRes = await fetch(`${supabaseUrl}/rest/v1/expenses`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "return=representation" },
        body: JSON.stringify({
          building_id, unit_id: unit_id || null, description,
          amount: Number(total_amount),
          expense_date: expense_date || new Date().toISOString().slice(0, 10),
          receipt_document_id: document_id || null,
          vendor_name: vendor_name || null,
          category: ALLOWED_CATEGORIES.includes(category) ? category : "autre",
          gst_amount: gst_amount != null ? Number(gst_amount) : null,
          qst_amount: qst_amount != null ? Number(qst_amount) : null,
        }),
      });
      const [expense] = await expenseRes.json().catch(() => [null]);
      if (!expenseRes.ok || !expense?.id) {
        return new Response(JSON.stringify({ error: "Impossible de créer la dépense" }), { status: 500, headers: corsHeaders });
      }
      if (document_id) {
        await fetch(`${supabaseUrl}/rest/v1/documents?id=eq.${document_id}`, {
          method: "PATCH", headers: adminHeaders, body: JSON.stringify({ building_id }),
        });
      }
      await logAudit("expense.create_from_ai_receipt", "expenses", expense.id, { vendor_name, category, amount: Number(total_amount), document_id: document_id || null });
      return new Response(JSON.stringify({ ok: true, expense_id: expense.id }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    console.error("parse-expense-receipt unexpected error", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
