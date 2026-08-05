// L'IA classe le sentiment d'un texte déjà écrit par un humain — elle
// n'invente jamais un motif d'insatisfaction et ne décide jamais seule
// d'escalader. La décision d'escalade est un seuil fixe et
// déterministe (voir ESCALATION_WINDOW_DAYS / NEGATIVE_PATTERN_THRESHOLD
// ci-dessous), calculé en code à partir de la classification IA.
// Déclenchée par le trigger SQL sur "messages" (nouveau message d'un
// propriétaire) et par handle-tenant-confirmation.ts (locataire qui
// rouvre une réparation) — jamais appelée directement par un usager.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MODEL_VERSION = "claude-haiku-4-5-20251001";
const PROMPT_VERSION = "satisfaction-signal-v1";
const ESCALATION_WINDOW_DAYS = 14;
const NEGATIVE_PATTERN_THRESHOLD = 2;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  try {
    const { source, subject_type, subject_id, related_entity_type, related_entity_id, content } = await req.json();
    if (!source || !subject_type || !subject_id || !content) {
      return new Response(JSON.stringify({ error: "Paramètres manquants" }), { status: 400, headers: corsHeaders });
    }

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const prompt = `Tu es l'assistant qui aide l'équipe de "Portail" (gestion immobilière au Québec) à repérer l'insatisfaction avant qu'elle ne s'aggrave. Voici un texte écrit par un ${subject_type === "owner" ? "propriétaire client" : "locataire"}. Classe UNIQUEMENT le ton de ce texte tel qu'il est écrit — n'invente aucun fait ni aucune cause qui ne serait pas dans le texte.

Texte : "${content}"

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après):
{
  "sentiment": "positif" | "neutre" | "negatif" | "tres_negatif",
  "reasoning": "une phrase en français expliquant pourquoi tu classes ce texte ainsi, basée uniquement sur son contenu",
  "confidence": un nombre entre 0 et 100
}`;

    const aiStartedAt = Date.now();
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": anthropicKey ?? "", "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL_VERSION, max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
    });
    const aiData = await aiRes.json();
    if (!aiRes.ok) {
      console.error("Anthropic API error", aiRes.status, JSON.stringify(aiData));
      await fetch(`${supabaseUrl}/rest/v1/ai_run_log`, {
        method: "POST", headers: adminHeaders,
        body: JSON.stringify({
          function_name: "analyze-satisfaction-signal", trigger_source: source, entity_type: subject_type, entity_id: subject_id,
          prompt_version: PROMPT_VERSION, model_version: MODEL_VERSION, input_summary: content.slice(0, 300),
          duration_ms: Date.now() - aiStartedAt, error: `anthropic_api_error ${aiRes.status}`,
        }),
      }).catch(() => null);
      return new Response(JSON.stringify({ error: "Erreur du service IA" }), { status: 502, headers: corsHeaders });
    }
    const rawText = aiData.content?.[0]?.text ?? "{}";
    const parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
    const sentiment = ["positif", "neutre", "negatif", "tres_negatif"].includes(parsed.sentiment) ? parsed.sentiment : "neutre";

    await fetch(`${supabaseUrl}/rest/v1/ai_run_log`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        function_name: "analyze-satisfaction-signal", trigger_source: source, entity_type: subject_type, entity_id: subject_id,
        prompt_version: PROMPT_VERSION, model_version: MODEL_VERSION, input_summary: content.slice(0, 300),
        output_summary: sentiment, confidence: parsed.confidence ?? null,
        needs_escalation: sentiment === "tres_negatif",
        duration_ms: Date.now() - aiStartedAt,
        input_tokens: aiData?.usage?.input_tokens ?? null, output_tokens: aiData?.usage?.output_tokens ?? null,
        automatic_action_taken: "signal_classe",
      }),
    }).catch((e) => console.error("Failed to write ai_run_log", e));

    // Seuil déterministe : un signal très négatif seul, OU un motif de
    // signaux négatifs répétés pour la même personne, déclenche
    // l'escalade — jamais l'IA elle-même.
    let priorNegativeCount = 0;
    if (sentiment === "negatif" || sentiment === "tres_negatif") {
      const windowStart = new Date(Date.now() - ESCALATION_WINDOW_DAYS * 86400000).toISOString();
      const priorRes = await fetch(
        `${supabaseUrl}/rest/v1/dissatisfaction_signals?subject_type=eq.${subject_type}&subject_id=eq.${subject_id}&ai_sentiment=in.(negatif,tres_negatif)&created_at=gte.${windowStart}&select=id`,
        { headers: adminHeaders },
      );
      const prior = await priorRes.json().catch(() => []);
      priorNegativeCount = Array.isArray(prior) ? prior.length : 0;
    }
    const escalate = sentiment === "tres_negatif" || (priorNegativeCount + 1) >= NEGATIVE_PATTERN_THRESHOLD;

    const insertRes = await fetch(`${supabaseUrl}/rest/v1/dissatisfaction_signals`, {
      method: "POST",
      headers: { ...adminHeaders, Prefer: "return=representation" },
      body: JSON.stringify({
        source, subject_type, subject_id,
        related_entity_type: related_entity_type || null, related_entity_id: related_entity_id || null,
        content_excerpt: content.slice(0, 500),
        ai_sentiment: sentiment, ai_reasoning: parsed.reasoning ?? null, ai_confidence: parsed.confidence ?? null,
        escalated: escalate, escalated_at: escalate ? new Date().toISOString() : null,
      }),
    });
    const [signal] = await insertRes.json();

    if (escalate) {
      await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST", headers: adminHeaders,
        body: JSON.stringify({ actor_type: "system", action: "dissatisfaction.escalated", entity_type: "dissatisfaction_signals", entity_id: signal?.id ?? null, details: { source, subject_type, subject_id, sentiment } }),
      });
      try {
        const adminsRes = await fetch(`${supabaseUrl}/rest/v1/users?is_admin=eq.true&select=email`, { headers: adminHeaders });
        const admins = await adminsRes.json().catch(() => []);
        const adminEmails = Array.isArray(admins) ? admins.map((a: any) => a.email).filter(Boolean) : [];
        if (adminEmails.length && resendKey) {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: "Portail <onboarding@resend.dev>",
              to: adminEmails,
              subject: `⚠ Signal d'insatisfaction à traiter (${subject_type === "owner" ? "propriétaire" : "locataire"})`,
              text: `Un signal d'insatisfaction a été détecté et nécessite ton attention.\n\nSource : ${source}\nExtrait : "${content.slice(0, 500)}"\n\nAnalyse IA (sentiment : ${sentiment}) : ${parsed.reasoning || "aucune explication fournie"}\n\nCeci est une classification automatique à titre indicatif — la décision d'action revient à l'équipe. Voir la section "Signaux d'insatisfaction" du portail admin.`,
            }),
          });
        }
      } catch (e) {
        console.error("Failed to notify admins of dissatisfaction signal", e);
      }
    }

    return new Response(JSON.stringify({ ok: true, sentiment, escalated: escalate }), { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error("analyze-satisfaction-signal unexpected error", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
