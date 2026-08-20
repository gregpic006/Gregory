// FAQ publique en question libre — sur le modèle du Copilot du portail
// propriétaire (ask-documents.ts / ask-finances.ts), mais sans authentification
// et sans accès à aucune donnée d'un compte : l'IA répond uniquement à partir
// d'une base de connaissance statique construite sur le vrai contenu du site,
// jamais depuis une base de données. Elle ne doit donc jamais pouvoir
// promettre, deviner, ou inventer une information spécifique à un client.
const MODEL_VERSION = "claude-haiku-4-5-20251001";
const PROMPT_VERSION = "public-faq-v1";
const RATE_LIMIT_PER_HOUR = 15;
const QUESTION_MAX_LENGTH = 500;

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

const KNOWLEDGE_BASE = `
Tu es l'assistant du site web de "Portail", une entreprise de gestion immobilière résidentielle dans la grande région de Québec.

FAITS RÉELS À UTILISER (ne réponds JAMAIS avec une information qui n'est pas ici) :
- Services inclus dans la gestion complète : gestion des locataires, perception et suivi des paiements, communications, location, visites, renouvellements de bail, demandes de service, coordination des travaux, approbation des dépenses, rapports aux propriétaires.
- L'entretien ménager n'est PAS offert.
- Tarification : 6% du loyer perçu par mois pour la gestion complète (plus taxes). 10% du coût des travaux pour la coordination de travaux (plus taxes).
- Toute dépense qui dépasse le plafond prévu au mandat du propriétaire doit être approuvée par le propriétaire avant d'être engagée.
- Les demandes sont reçues 24/7, avec réponse automatique ; les urgences sont transmises sans délai à une personne.
- Chaque visite de logement est prise en charge par une personne vérifiée et formée.
- Pour visiter un logement disponible : remplir le formulaire "Demander une visite" sur la fiche du logement.
- Pour devenir client (confier un immeuble en gestion) : remplir le formulaire "Obtenir une évaluation gratuite" — un membre de l'équipe contacte ensuite la personne, sans engagement.
- Il existe un portail propriétaire et un portail locataire, accessibles via "Connexion" sur le site.
- Le site n'affiche pas encore de numéro de téléphone ni de courriel de contact direct — ne jamais en inventer un.

RÈGLES STRICTES :
- Réponds en français, de façon brève et directe (2-4 phrases maximum).
- N'invente JAMAIS un prix, un délai, un nom de personne, un numéro de téléphone ou un courriel qui n'est pas dans les faits ci-dessus.
- Ne confirme JAMAIS la disponibilité d'un logement précis ni un prix précis — redirige vers la section "Logements disponibles" du site.
- Ne garantis JAMAIS qu'un mandat de gestion sera accepté — redirige vers le formulaire d'évaluation gratuite.
- Si la question sort du cadre de Portail (gestion immobilière) ou si tu ne connais pas la réponse à partir des faits ci-dessus, dis-le honnêtement et redirige vers le formulaire approprié plutôt que d'inventer une réponse.
- Ne donne jamais de conseil juridique (bail, Loi 25, Tribunal administratif du logement) — recommande de consulter les ressources officielles.
`.trim();

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const { question, website } = body;

    // Honeypot : un bot remplit ce champ invisible, un humain ne le voit jamais.
    if (website) {
      return new Response(JSON.stringify({ answer: "" }), { status: 200, headers: corsHeaders });
    }

    if (!question || typeof question !== "string" || !question.trim()) {
      return new Response(JSON.stringify({ error: "Question manquante" }), { status: 400, headers: corsHeaders });
    }
    if (question.length > QUESTION_MAX_LENGTH) {
      return new Response(JSON.stringify({ error: "Question trop longue" }), { status: 400, headers: corsHeaders });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const rateRes = await fetch(
      `${supabaseUrl}/rest/v1/public_faq_log?ip_address=eq.${encodeURIComponent(ip)}&created_at=gte.${oneHourAgo}&select=id`,
      { headers: adminHeaders },
    );
    const recent = await rateRes.json();
    if (Array.isArray(recent) && recent.length >= RATE_LIMIT_PER_HOUR) {
      return new Response(JSON.stringify({ error: "Trop de questions envoyées récemment — réessaie plus tard." }), { status: 429, headers: corsHeaders });
    }

    await fetch(`${supabaseUrl}/rest/v1/public_faq_log`, {
      method: "POST", headers: adminHeaders, body: JSON.stringify({ ip_address: ip }),
    });

    const aiStartedAt = Date.now();
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL_VERSION,
        max_tokens: 350,
        system: KNOWLEDGE_BASE,
        messages: [{ role: "user", content: question.trim().slice(0, QUESTION_MAX_LENGTH) }],
      }),
    });
    const aiData = await aiRes.json();
    if (!aiRes.ok) {
      console.error("Anthropic API error", aiRes.status, JSON.stringify(aiData));
      await fetch(`${supabaseUrl}/rest/v1/ai_run_log`, {
        method: "POST", headers: adminHeaders,
        body: JSON.stringify({
          function_name: "handle-public-faq", trigger_source: "public_site",
          prompt_version: PROMPT_VERSION, model_version: MODEL_VERSION, input_summary: question.slice(0, 300),
          duration_ms: Date.now() - aiStartedAt, error: `anthropic_api_error ${aiRes.status}`,
        }),
      }).catch(() => null);
      return new Response(JSON.stringify({ error: "Erreur du service, réessaie dans un instant." }), { status: 502, headers: corsHeaders });
    }
    const answer = aiData.content?.[0]?.text ?? "Désolé, je n'ai pas pu générer de réponse.";

    await fetch(`${supabaseUrl}/rest/v1/ai_run_log`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        function_name: "handle-public-faq",
        trigger_source: "public_site",
        prompt_version: PROMPT_VERSION,
        model_version: MODEL_VERSION,
        input_summary: question.slice(0, 300),
        output_summary: answer.slice(0, 300),
        duration_ms: Date.now() - aiStartedAt,
        input_tokens: aiData?.usage?.input_tokens ?? null,
        output_tokens: aiData?.usage?.output_tokens ?? null,
      }),
    }).catch((e) => console.error("Failed to write ai_run_log", e));

    return new Response(JSON.stringify({ answer }), { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error("handle-public-faq unexpected error", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
