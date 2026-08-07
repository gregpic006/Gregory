// Portail des cold callers (travailleurs autonomes de prospection
// téléphonique). Contrairement à crm-api.ts (réservé aux admins), cette
// fonction sert un compte "caller" — mais elle n'ouvre AUCUNE policy RLS
// sur prospects (qui reste verrouillée au rôle service_role, voir
// schema.sql). Chaque action ici vérifie explicitement que le prospect
// visé est bien assigné à l'appelant connecté avant d'y toucher, exactement
// comme crm-api.ts le fait pour l'admin — la même donnée sensible, gardée
// par la même discipline, juste un périmètre plus étroit.
//
// Un cold caller ne peut PAS fermer un dossier (stage 'signed'/'lost') ni
// modifier le coût d'acquisition — ces décisions restent à l'admin via
// crm-api.ts. Il peut seulement faire progresser un prospect de 'new' à
// 'contacted' ou 'interested'.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CALLER_ALLOWED_STAGES = ["contacted", "interested"];

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
    const payloadBase64 = jwt.split(".")[1];
    const claims = JSON.parse(atob(payloadBase64.replace(/-/g, "+").replace(/_/g, "/")));
    const userId = claims.sub;

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const callerRes = await fetch(`${supabaseUrl}/rest/v1/cold_callers?user_id=eq.${userId}&select=id,full_name,active`, { headers: adminHeaders });
    const [caller] = await callerRes.json().catch(() => [null]);
    if (!caller || !caller.active) {
      return new Response(JSON.stringify({ error: "Accès refusé — compte cold caller introuvable ou désactivé" }), { status: 403, headers: corsHeaders });
    }
    const callerId = caller.id;

    const logAudit = (action: string, entityId: string | null, details: Record<string, unknown>) =>
      fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ actor_type: "caller", actor_id: userId, action, entity_type: "prospects", entity_id: entityId, details }),
      });

    const body = await req.json().catch(() => ({}));
    const action = body.action || "list_my_prospects";

    if (action === "list_my_prospects") {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/prospects?assigned_caller_id=eq.${callerId}&select=id,full_name,email,phone,company_name,num_doors,avg_rent,potential_monthly_revenue,stage,interest_level,next_followup_date,call_history,notes,created_at&order=next_followup_date.asc.nullslast`,
        { headers: adminHeaders },
      );
      const prospects = await res.json();
      return new Response(JSON.stringify({ prospects }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "my_stats") {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/prospects?assigned_caller_id=eq.${callerId}&select=stage,call_history,next_followup_date`,
        { headers: adminHeaders },
      );
      const prospects = await res.json();
      const today = new Date().toISOString().slice(0, 10);
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const byStage: Record<string, number> = {};
      let callsToday = 0;
      let callsThisWeek = 0;
      let overdueFollowups = 0;
      for (const p of prospects) {
        byStage[p.stage] = (byStage[p.stage] || 0) + 1;
        if (p.next_followup_date && p.next_followup_date < today) overdueFollowups++;
        const history = Array.isArray(p.call_history) ? p.call_history : [];
        for (const c of history) {
          const day = String(c.date || "").slice(0, 10);
          if (day === today) callsToday++;
          if (day >= weekAgo) callsThisWeek++;
        }
      }
      return new Response(JSON.stringify({
        total_assigned: prospects.length,
        by_stage: byStage,
        calls_today: callsToday,
        calls_this_week: callsThisWeek,
        overdue_followups: overdueFollowups,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "add_call") {
      const { prospect_id, transcript } = body;
      if (!prospect_id || !transcript) {
        return new Response(JSON.stringify({ error: "prospect_id et transcript requis" }), { status: 400, headers: corsHeaders });
      }
      const prospRes = await fetch(`${supabaseUrl}/rest/v1/prospects?id=eq.${prospect_id}&select=*`, { headers: adminHeaders });
      const [prospect] = await prospRes.json();
      if (!prospect) {
        return new Response(JSON.stringify({ error: "Prospect introuvable" }), { status: 404, headers: corsHeaders });
      }
      if (prospect.assigned_caller_id !== callerId) {
        return new Response(JSON.stringify({ error: "Ce prospect ne t'est pas assigné" }), { status: 403, headers: corsHeaders });
      }

      const prompt = `Tu es l'assistant CRM de "Portail". Voici la transcription/notes d'un appel avec un prospect propriétaire. Analyse-la en détail.

Transcription: "${transcript}"

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après):
{
  "summary": "résumé de l'appel en 1-2 phrases en français",
  "key_quotes": ["jusqu'à 2 citations exactes et importantes tirées de la transcription"],
  "objections": "les objections ou réticences exprimées par le prospect, ou null si aucune",
  "commitment": "un engagement concret pris durant l'appel (ex: 'va envoyer les états financiers d'ici vendredi'), ou null si aucun",
  "next_step": "la prochaine étape concrète à faire avec ce prospect, en une phrase",
  "interest_level": "chaud ou tiede ou froid",
  "confidence": un nombre entre 0 et 100 représentant ta confiance dans cette analyse — baisse-la si la transcription est courte, vague ou ambiguë,
  "next_followup_days": un nombre entier de jours avant le prochain suivi recommandé
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
          max_tokens: 500,
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

      const followupDate = parsed.next_followup_days
        ? new Date(Date.now() + parsed.next_followup_days * 86400000).toISOString().slice(0, 10)
        : prospect.next_followup_date;
      const allowedInterestLevels = ["chaud", "tiede", "froid"];
      const interestLevel = allowedInterestLevels.includes(parsed.interest_level) ? parsed.interest_level : null;
      const callHistory = Array.isArray(prospect.call_history) ? prospect.call_history : [];
      // Comme dans crm-api.ts : l'IA ne touche jamais "stage" — seule une
      // action humaine explicite (ici update_my_stage) le peut.
      callHistory.push({
        date: new Date().toISOString(),
        transcript,
        summary: parsed.summary ?? transcript,
        key_quotes: Array.isArray(parsed.key_quotes) ? parsed.key_quotes : [],
        objections: parsed.objections ?? null,
        commitment: parsed.commitment ?? null,
        next_step: parsed.next_step ?? null,
        interest_level: interestLevel,
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
        corrected: false,
        caller_id: callerId,
      });

      await fetch(`${supabaseUrl}/rest/v1/prospects?id=eq.${prospect_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({
          call_history: callHistory,
          interest_level: interestLevel ?? prospect.interest_level,
          next_followup_date: followupDate,
        }),
      });
      await logAudit("prospect.call_logged_by_caller", prospect_id, { caller_name: caller.full_name });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "update_my_stage") {
      const { prospect_id, stage } = body;
      if (!prospect_id || !CALLER_ALLOWED_STAGES.includes(stage)) {
        return new Response(JSON.stringify({ error: "Statut invalide pour un cold caller" }), { status: 400, headers: corsHeaders });
      }
      const prospRes = await fetch(`${supabaseUrl}/rest/v1/prospects?id=eq.${prospect_id}&select=assigned_caller_id`, { headers: adminHeaders });
      const [prospect] = await prospRes.json();
      if (!prospect || prospect.assigned_caller_id !== callerId) {
        return new Response(JSON.stringify({ error: "Ce prospect ne t'est pas assigné" }), { status: 403, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/prospects?id=eq.${prospect_id}`, {
        method: "PATCH", headers: adminHeaders, body: JSON.stringify({ stage }),
      });
      await logAudit("prospect.stage_change_by_caller", prospect_id, { new_stage: stage, caller_name: caller.full_name });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
