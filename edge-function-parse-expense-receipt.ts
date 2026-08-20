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
// Liste blanche d'origines : évite d'exposer les fonctions à un
// site tiers qui embarquerait un appel authentifié depuis le
// navigateur d'un usager (CSRF via fetch). Les appels serveur à
// serveur (cron, webhooks, autre fonction edge) n'envoient pas
// d'en-tête Origin et ne sont donc pas affectés par ce contrôle.
const ALLOWED_ORIGINS = ["https://portailgestion.ca", "https://www.portailgestion.ca"];
function corsHeadersFor(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

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
// Vérifie le JWT en le faisant valider par le service Auth de Supabase
// lui-même (GET /auth/v1/user) plutôt qu'en réimplémentant la
// cryptographie de vérification. La passerelle Edge Functions a un bug
// connu qui rejette à tort les JWT signés en ES256 quand verify_jwt=true
// est réglé au niveau plateforme (github.com/supabase/supabase/issues/42244)
// — d'où verify_jwt=false dans supabase/config.toml pour cette fonction :
// ce code est maintenant la seule vérification, et s'appuie sur l'API
// Auth de Supabase, qui elle gère ES256 correctement.
async function verifySupabaseJwt(jwt: string, supabaseUrl: string): Promise<{ sub: string; [key: string]: unknown } | null> {
  if (!jwt) return null;
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      },
    });
    if (!res.ok) return null;
    const user = await res.json().catch(() => null);
    if (!user?.id) return null;
    return { sub: user.id, ...user };
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  try {
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), { status: 401, headers: corsHeaders });
    }
    const claims = await verifySupabaseJwt(jwt, Deno.env.get("SUPABASE_URL") ?? "");
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
