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
    // Durcissement (Lot 7 TWIM) : ces en-têtes ne coûtent rien et
    // réduisent la surface d'attaque même si le contenu JSON renvoyé
    // n'est pas du HTML — défense en profondeur, pas une réaction à un
    // vecteur d'attaque identifié ici.
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
}

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
    const userRows = await userRes.json();
    if (!userRows?.[0]?.is_admin) {
      return new Response(JSON.stringify({ error: "Accès refusé — compte non admin" }), { status: 403, headers: corsHeaders });
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action || "list";

    if (action === "list") {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/prospects?select=*,cold_callers(id,full_name)&order=potential_monthly_revenue.desc.nullslast`,
        { headers: adminHeaders },
      );
      const prospects = await res.json();
      return new Response(JSON.stringify({ prospects }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "list_callers") {
      const callersRes = await fetch(`${supabaseUrl}/rest/v1/cold_callers?select=id,full_name,phone,email,active&order=full_name.asc`, { headers: adminHeaders });
      const callers = await callersRes.json();
      const prospRes = await fetch(`${supabaseUrl}/rest/v1/prospects?assigned_caller_id=not.is.null&select=assigned_caller_id,stage,call_history`, { headers: adminHeaders });
      const prospects = await prospRes.json();
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const stats: Record<string, { total_assigned: number; by_stage: Record<string, number>; calls_this_week: number }> = {};
      for (const p of prospects) {
        const s = (stats[p.assigned_caller_id] ??= { total_assigned: 0, by_stage: {}, calls_this_week: 0 });
        s.total_assigned++;
        s.by_stage[p.stage] = (s.by_stage[p.stage] || 0) + 1;
        const history = Array.isArray(p.call_history) ? p.call_history : [];
        for (const c of history) {
          if (String(c.date || "").slice(0, 10) >= weekAgo) s.calls_this_week++;
        }
      }
      const callersWithStats = callers.map((c: any) => ({ ...c, stats: stats[c.id] || { total_assigned: 0, by_stage: {}, calls_this_week: 0 } }));
      return new Response(JSON.stringify({ callers: callersWithStats }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "assign_caller") {
      const { prospect_id, caller_id } = body;
      if (!prospect_id) {
        return new Response(JSON.stringify({ error: "prospect_id manquant" }), { status: 400, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/prospects?id=eq.${prospect_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ assigned_caller_id: caller_id || null }),
      });
      await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ actor_type: "admin", actor_id: userId, action: "prospect.caller_assigned", entity_type: "prospects", entity_id: prospect_id, details: { caller_id: caller_id || null } }),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "toggle_caller_active") {
      const { caller_id, active } = body;
      if (!caller_id) {
        return new Response(JSON.stringify({ error: "caller_id manquant" }), { status: 400, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/cold_callers?id=eq.${caller_id}`, {
        method: "PATCH", headers: adminHeaders, body: JSON.stringify({ active: !!active }),
      });
      await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ actor_type: "admin", actor_id: userId, action: active ? "cold_caller.reactivated" : "cold_caller.deactivated", entity_type: "cold_callers", entity_id: caller_id, details: {} }),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "create") {
      const { full_name, email, phone, company_name, num_doors, avg_rent, lead_source, acquisition_cost } = body;
      const potential = num_doors && avg_rent ? Math.round(num_doors * avg_rent * 0.06 * 100) / 100 : null;
      await fetch(`${supabaseUrl}/rest/v1/prospects`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          full_name, email, phone, company_name,
          num_doors: num_doors || null,
          avg_rent: avg_rent || null,
          potential_monthly_revenue: potential,
          stage: "new",
          lead_source: lead_source || "manuel",
          acquisition_cost: acquisition_cost || null,
        }),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "update_stage") {
      const { prospect_id, stage, loss_reason } = body;
      const patchBody: Record<string, unknown> = { stage };
      if (stage === "lost") patchBody.loss_reason = loss_reason || null;
      await fetch(`${supabaseUrl}/rest/v1/prospects?id=eq.${prospect_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify(patchBody),
      });
      await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ actor_type: "admin", actor_id: userId, action: "prospect.stage_change", entity_type: "prospects", entity_id: prospect_id, details: { new_stage: stage, loss_reason: stage === "lost" ? (loss_reason || null) : undefined } }),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "update_acquisition_cost") {
      const { prospect_id, acquisition_cost } = body;
      if (!prospect_id) {
        return new Response(JSON.stringify({ error: "prospect_id manquant" }), { status: 400, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/prospects?id=eq.${prospect_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ acquisition_cost: acquisition_cost === "" ? null : Number(acquisition_cost) }),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "add_call") {
      const { prospect_id, transcript } = body;
      const prospRes = await fetch(`${supabaseUrl}/rest/v1/prospects?id=eq.${prospect_id}&select=*`, { headers: adminHeaders });
      const [prospect] = await prospRes.json();
      if (!prospect) {
        return new Response(JSON.stringify({ error: "prospect introuvable" }), { status: 404, headers: corsHeaders });
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
      // interest_level est affiché tel quel dans l'admin — on le limite à
      // une whitelist stricte, jamais le texte libre renvoyé par l'IA.
      const allowedInterestLevels = ["chaud", "tiede", "froid"];
      const interestLevel = allowedInterestLevels.includes(parsed.interest_level) ? parsed.interest_level : null;
      const callHistory = Array.isArray(prospect.call_history) ? prospect.call_history : [];
      // Note : cette fonction ne touche JAMAIS "stage" — l'IA ne peut pas
      // classer un prospect "perdu" ni bloquer une relance ; seule
      // l'action "update_stage" (déclenchée par un humain) le peut.
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
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    // Un vendeur peut corriger une analyse d'appel que l'IA a mal
    // évaluée. La correction est conservée (avec l'original) dans
    // l'historique et journalisée pour permettre, plus tard, une revue
    // des écarts et l'amélioration du prompt.
    if (action === "correct_call") {
      const { prospect_id, call_index, corrections, correction_note } = body;
      const prospRes = await fetch(`${supabaseUrl}/rest/v1/prospects?id=eq.${prospect_id}&select=call_history`, { headers: adminHeaders });
      const [prospect] = await prospRes.json();
      const callHistory = Array.isArray(prospect?.call_history) ? prospect.call_history : [];
      if (!prospect || call_index == null || !callHistory[call_index]) {
        return new Response(JSON.stringify({ error: "appel introuvable" }), { status: 404, headers: corsHeaders });
      }

      const original = { ...callHistory[call_index] };
      callHistory[call_index] = { ...original, ...corrections, corrected: true, correction_note: correction_note || null };

      await fetch(`${supabaseUrl}/rest/v1/prospects?id=eq.${prospect_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ call_history: callHistory }),
      });
      await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          actor_type: "admin", actor_id: userId, action: "prospect.call_corrected",
          entity_type: "prospects", entity_id: prospect_id,
          details: { call_index, original, corrections, correction_note: correction_note || null },
        }),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
