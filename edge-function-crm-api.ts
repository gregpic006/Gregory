const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

    const userRes = await fetch(`${supabaseUrl}/rest/v1/users?id=eq.${userId}&select=is_admin`, { headers: adminHeaders });
    const userRows = await userRes.json();
    if (!userRows?.[0]?.is_admin) {
      return new Response(JSON.stringify({ error: "Accès refusé — compte non admin" }), { status: 403, headers: corsHeaders });
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action || "list";

    if (action === "list") {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/prospects?select=*&order=potential_monthly_revenue.desc.nullslast`,
        { headers: adminHeaders },
      );
      const prospects = await res.json();
      return new Response(JSON.stringify({ prospects }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "create") {
      const { full_name, email, phone, company_name, num_doors, avg_rent } = body;
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
        }),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "update_stage") {
      const { prospect_id, stage } = body;
      await fetch(`${supabaseUrl}/rest/v1/prospects?id=eq.${prospect_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ stage }),
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

      const prompt = `Tu es l'assistant CRM de "Portail". Voici la transcription/notes d'un appel avec un prospect propriétaire. Résume-le et évalue son niveau d'intérêt.

Transcription: "${transcript}"

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après):
{
  "summary": "résumé de l'appel en 1-2 phrases en français",
  "interest_level": "chaud ou tiede ou froid",
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
          max_tokens: 400,
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
      const callHistory = Array.isArray(prospect.call_history) ? prospect.call_history : [];
      callHistory.push({ date: new Date().toISOString(), summary: parsed.summary ?? transcript });

      await fetch(`${supabaseUrl}/rest/v1/prospects?id=eq.${prospect_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({
          call_history: callHistory,
          interest_level: parsed.interest_level ?? prospect.interest_level,
          next_followup_date: followupDate,
        }),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
