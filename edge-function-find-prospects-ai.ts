// find-prospects-ai : recherche web réelle (jamais inventée) de
// propriétaires-gestionnaires (immeubles à logements qu'ils gèrent
// eux-mêmes) au Québec, via Claude + l'outil serveur web_search.
//
// Cible EXCLUSIVEMENT des propriétaires qui gèrent eux-mêmes leur(s)
// immeuble(s) — jamais une entreprise de gestion immobilière, une agence
// de location ou un courtier : ce sont des concurrents de Portail, pas
// des prospects.
//
// Chaque prospect soumis doit inclure "source_url" (page web réelle où
// l'information a été trouvée) — aucune coordonnée n'est acceptée si
// elle n'est pas rattachée à une source vérifiable, pour respecter la
// règle du projet : aucune donnée fictive sur le site en production.
//
// Appelée par pg_cron (voir trigger_find_prospects_ai dans schema.sql)
// ET par le bouton admin "Chercher des prospects maintenant" — même
// convention que flinks-api "sync_all" : aucune vérification JWT/is_admin
// ici, cette action ne fait qu'insérer des prospects (aucune donnée
// sensible exposée en retour).
//
// Auto-assignation : chaque prospect trouvé est assigné directement au
// cold caller actif le moins chargé (aucune approbation admin requise
// avant assignation, sur demande explicite).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_PROSPECTS_PER_RUN = 5;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const body = await req.json().catch(() => ({}));
    const action = body.action || "run";
    if (action !== "run") {
      return new Response(JSON.stringify({ error: "Action inconnue" }), { status: 400, headers: corsHeaders });
    }

    // 1. Cold callers actifs — pas de callers actifs, pas de recherche
    // (on ne veut jamais de prospect trouvé qui reste orphelin sans suivi).
    const callersRes = await fetch(`${supabaseUrl}/rest/v1/cold_callers?active=eq.true&select=id,full_name`, { headers: adminHeaders });
    const callers = await callersRes.json().catch(() => []);
    if (!Array.isArray(callers) || callers.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, inserted: 0, note: "Aucun cold caller actif — recherche annulée." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Charge actuelle de chaque caller (prospects assignés encore actifs)
    // pour répartir les nouveaux leads vers le moins chargé.
    const loadRes = await fetch(
      `${supabaseUrl}/rest/v1/prospects?assigned_caller_id=not.is.null&stage=not.in.(signed,lost)&select=assigned_caller_id`,
      { headers: adminHeaders },
    );
    const loadRows = await loadRes.json().catch(() => []);
    const loadByCallerId: Record<string, number> = {};
    for (const c of callers) loadByCallerId[c.id] = 0;
    for (const row of Array.isArray(loadRows) ? loadRows : []) {
      loadByCallerId[row.assigned_caller_id] = (loadByCallerId[row.assigned_caller_id] || 0) + 1;
    }
    const pickLeastLoadedCaller = () => {
      const sorted = [...callers].sort((a: any, b: any) => (loadByCallerId[a.id] || 0) - (loadByCallerId[b.id] || 0));
      const chosen = sorted[0];
      loadByCallerId[chosen.id] = (loadByCallerId[chosen.id] || 0) + 1;
      return chosen;
    };

    // 2. Coordonnées déjà présentes dans le pipeline, pour éviter les doublons.
    const existingRes = await fetch(`${supabaseUrl}/rest/v1/prospects?select=phone,email`, { headers: adminHeaders });
    const existing = await existingRes.json().catch(() => []);
    const existingPhones = new Set(
      (Array.isArray(existing) ? existing : []).map((p: any) => String(p.phone || "").replace(/\D/g, "")).filter(Boolean),
    );
    const existingEmails = new Set(
      (Array.isArray(existing) ? existing : []).map((p: any) => String(p.email || "").toLowerCase()).filter(Boolean),
    );

    // 3. Recherche web réelle via Claude — jamais de données inventées.
    const prompt = `Tu es un chercheur de prospects pour "Portail", une entreprise québécoise de gestion immobilière qui offre ses services à des propriétaires qui gèrent eux-mêmes leurs immeubles à logements.

Utilise l'outil de recherche web pour trouver de VRAIS propriétaires au Québec qui possèdent et gèrent eux-mêmes un ou plusieurs immeubles à logements (plusieurs unités locatives), et qui ne semblent pas déjà faire affaire avec une entreprise de gestion immobilière.

RÈGLES STRICTES :
- Ne cible JAMAIS une entreprise de gestion immobilière, une agence de location, un courtier immobilier ou toute entreprise qui gère des immeubles POUR d'autres propriétaires — ce sont des concurrents de Portail, pas des prospects.
- Ne cible que des propriétaires individuels, des sociétés à numéro ou des petites entreprises familiales qui gèrent LEURS PROPRES immeubles.
- N'invente JAMAIS un nom, un numéro de téléphone, un courriel ou une adresse. Si une information exacte n'apparaît pas dans les résultats de recherche, laisse le champ à null ou omets complètement ce prospect.
- Chaque prospect soumis doit obligatoirement inclure "source_url" : l'URL réelle de la page où tu as trouvé l'information (annonce Kijiji/Facebook Marketplace/Centris publiée par le propriétaire lui-même, registre des entreprises, article, site web personnel, etc.).
- Un prospect doit avoir au moins un téléphone OU un courriel trouvé réellement — sinon ne le soumets pas.
- Maximum ${MAX_PROSPECTS_PER_RUN} prospects.

Une fois ta recherche terminée, appelle l'outil "submit_prospects" avec les prospects trouvés.`;

    const tools = [
      { type: "web_search_20260209", name: "web_search" },
      {
        name: "submit_prospects",
        description: "Soumet la liste finale des prospects réels trouvés par la recherche web, avec leur source.",
        input_schema: {
          type: "object",
          properties: {
            prospects: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  full_name: { type: "string", description: "Nom du propriétaire ou de la société propriétaire" },
                  company_name: { type: ["string", "null"] },
                  phone: { type: ["string", "null"] },
                  email: { type: ["string", "null"] },
                  city: { type: ["string", "null"] },
                  num_doors: { type: ["number", "null"], description: "Nombre d'unités locatives, si mentionné" },
                  source_url: { type: "string", description: "URL réelle de la page où l'information a été trouvée" },
                  notes: { type: "string", description: "Contexte trouvé (ex: annonce publiée, type d'immeuble, ville)" },
                },
                required: ["full_name", "source_url", "notes"],
              },
            },
          },
          required: ["prospects"],
        },
      },
    ];

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 4096,
        tools,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const aiData = await aiRes.json();
    if (!aiRes.ok) {
      return new Response(
        JSON.stringify({ error: aiData?.error?.message || "Échec de la recherche IA" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Le résultat structuré vient exclusivement du tool_use "submit_prospects"
    // — jamais parsé depuis du texte libre, pour éviter toute dérive de format.
    const toolUseBlock = (aiData.content || []).find((b: any) => b.type === "tool_use" && b.name === "submit_prospects");
    const foundProspects = Array.isArray(toolUseBlock?.input?.prospects) ? toolUseBlock.input.prospects : [];

    let inserted = 0;
    const results: Record<string, unknown>[] = [];
    for (const p of foundProspects.slice(0, MAX_PROSPECTS_PER_RUN)) {
      if (!p?.full_name || !p?.source_url) continue;
      const phoneDigits = String(p.phone || "").replace(/\D/g, "");
      const emailLower = String(p.email || "").toLowerCase();
      if (!phoneDigits && !emailLower) continue; // aucune coordonnée exploitable trouvée — on ignore
      if (phoneDigits && existingPhones.has(phoneDigits)) continue;
      if (emailLower && existingEmails.has(emailLower)) continue;

      const caller = pickLeastLoadedCaller();
      const insertRes = await fetch(`${supabaseUrl}/rest/v1/prospects`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "return=representation" },
        body: JSON.stringify({
          full_name: p.full_name,
          company_name: p.company_name || null,
          phone: p.phone || null,
          email: p.email || null,
          stage: "new",
          lead_source: "ai_web_search",
          source_url: p.source_url,
          notes: p.notes || null,
          num_doors: typeof p.num_doors === "number" ? p.num_doors : null,
          assigned_caller_id: caller.id,
        }),
      });
      const insertedRows = await insertRes.json().catch(() => []);
      const createdProspect = Array.isArray(insertedRows) ? insertedRows[0] : null;
      if (!createdProspect?.id) continue;

      if (phoneDigits) existingPhones.add(phoneDigits);
      if (emailLower) existingEmails.add(emailLower);
      inserted++;
      results.push({ id: createdProspect.id, full_name: p.full_name, assigned_caller_id: caller.id, assigned_caller_name: caller.full_name, source_url: p.source_url });

      await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          actor_type: "system",
          actor_id: null,
          action: "prospect.ai_found_and_assigned",
          entity_type: "prospects",
          entity_id: createdProspect.id,
          details: { caller_id: caller.id, caller_name: caller.full_name, source_url: p.source_url },
        }),
      });
    }

    return new Response(
      JSON.stringify({ ok: true, inserted, results }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: corsHeaders });
  }
});
