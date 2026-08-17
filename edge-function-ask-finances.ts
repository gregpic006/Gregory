// Portail Copilot — Q&A financier en langage naturel pour le propriétaire.
// Principe non négociable du projet : l'IA ne calcule jamais elle-même
// les montants. Toutes les sommes (revenus, dépenses par catégorie, par
// mois, par immeuble) sont agrégées déterministiquement ici en code
// avant d'être envoyées à Claude — l'IA ne fait que choisir les bons
// chiffres déjà calculés et rédiger la réponse en français, jamais
// d'arithmétique de sa part sur des données brutes.
const MODEL_VERSION = "claude-haiku-4-5-20251001";
const PROMPT_VERSION = "ask-finances-v1-aggregats-precalcules";
const LOOKBACK_MONTHS = 24;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function monthKey(dateStr: string): string {
  return (dateStr || "").slice(0, 7); // "YYYY-MM"
}

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
  const res = await fetch(`${supabaseUrl}/auth/v1/jwks`, {
    headers: { apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "" },
  });
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
    const { question } = await req.json();
    if (!question || typeof question !== "string" || !question.trim()) {
      return new Response(JSON.stringify({ error: "Question manquante" }), { status: 400, headers: corsHeaders });
    }

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

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const ownerRes = await fetch(
      `${supabaseUrl}/rest/v1/owners?user_id=eq.${userId}&select=id,full_name,spending_cap,management_rate`,
      { headers: adminHeaders },
    );
    const [owner] = await ownerRes.json();
    if (!owner) {
      return new Response(JSON.stringify({ error: "Aucun profil propriétaire associé à ce compte" }), { status: 403, headers: corsHeaders });
    }

    const buildingsRes = await fetch(
      `${supabaseUrl}/rest/v1/buildings?owner_id=eq.${owner.id}&select=id,address,unit_count`,
      { headers: adminHeaders },
    );
    const buildings = await buildingsRes.json();
    const buildingIds: string[] = Array.isArray(buildings) ? buildings.map((b: any) => b.id) : [];
    const buildingAddressById: Record<string, string> = {};
    for (const b of buildings || []) buildingAddressById[b.id] = b.address;

    if (buildingIds.length === 0) {
      return new Response(JSON.stringify({ answer: "Tu n'as encore aucun immeuble enregistré — je ne peux donc pas répondre à une question financière." }), { status: 200, headers: corsHeaders });
    }

    const unitsRes = await fetch(
      `${supabaseUrl}/rest/v1/units?building_id=in.(${buildingIds.join(",")})&select=id,building_id,rent,status`,
      { headers: adminHeaders },
    );
    const units = await unitsRes.json();
    const unitIds: string[] = Array.isArray(units) ? units.map((u: any) => u.id) : [];

    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - LOOKBACK_MONTHS);
    const cutoffStr = cutoffDate.toISOString().slice(0, 10);

    let leases: any[] = [];
    if (unitIds.length > 0) {
      const leasesRes = await fetch(
        `${supabaseUrl}/rest/v1/leases?unit_id=in.(${unitIds.join(",")})&select=id,unit_id,monthly_rent,status`,
        { headers: adminHeaders },
      );
      leases = await leasesRes.json();
    }
    const leaseIds: string[] = Array.isArray(leases) ? leases.map((l: any) => l.id) : [];

    let payments: any[] = [];
    if (leaseIds.length > 0) {
      const paymentsRes = await fetch(
        `${supabaseUrl}/rest/v1/payments?lease_id=in.(${leaseIds.join(",")})&due_date=gte.${cutoffStr}&select=amount,due_date,paid_date,status&order=due_date.desc&limit=500`,
        { headers: adminHeaders },
      );
      payments = await paymentsRes.json();
    }

    const expensesRes = await fetch(
      `${supabaseUrl}/rest/v1/expenses?building_id=in.(${buildingIds.join(",")})&expense_date=gte.${cutoffStr}&select=amount,expense_date,category,vendor_name,description,building_id&order=expense_date.desc&limit=500`,
      { headers: adminHeaders },
    );
    const expenses = await expensesRes.json();

    const invoicesRes = await fetch(
      `${supabaseUrl}/rest/v1/invoices?owner_id=eq.${owner.id}&select=invoice_number,period_start,period_end,total_amount,status&order=period_end.desc&limit=${LOOKBACK_MONTHS}`,
      { headers: adminHeaders },
    );
    const invoices = await invoicesRes.json();

    // ---- Agrégats déterministes (aucun calcul laissé à l'IA) ----
    const revenueByMonth: Record<string, number> = {};
    let totalRevenuePaid = 0;
    let latePaymentsCount = 0;
    for (const p of Array.isArray(payments) ? payments : []) {
      const key = monthKey(p.due_date);
      if (p.status === "paid") {
        revenueByMonth[key] = (revenueByMonth[key] || 0) + Number(p.amount);
        totalRevenuePaid += Number(p.amount);
      }
      if (p.status === "late") latePaymentsCount += 1;
    }

    const expensesByMonth: Record<string, number> = {};
    const expensesByCategory: Record<string, number> = {};
    const expensesByBuilding: Record<string, number> = {};
    let totalExpenses = 0;
    for (const e of Array.isArray(expenses) ? expenses : []) {
      const key = monthKey(e.expense_date);
      const cat = e.category || "non catégorisé";
      const addr = buildingAddressById[e.building_id] || "immeuble inconnu";
      expensesByMonth[key] = (expensesByMonth[key] || 0) + Number(e.amount);
      expensesByCategory[cat] = (expensesByCategory[cat] || 0) + Number(e.amount);
      expensesByBuilding[addr] = (expensesByBuilding[addr] || 0) + Number(e.amount);
      totalExpenses += Number(e.amount);
    }

    const totalManagementFees = (Array.isArray(invoices) ? invoices : [])
      .filter((i: any) => i.status === "paid")
      .reduce((sum: number, i: any) => sum + Number(i.total_amount), 0);

    const occupiedUnits = (Array.isArray(units) ? units : []).filter((u: any) => u.status === "occupied").length;
    const totalUnits = Array.isArray(units) ? units.length : 0;

    const aggregates = {
      periode_analysee: `${LOOKBACK_MONTHS} derniers mois (depuis ${cutoffStr})`,
      immeubles: (buildings || []).map((b: any) => ({ adresse: b.address, nb_logements: b.unit_count })),
      occupation: `${occupiedUnits} logement(s) occupé(s) sur ${totalUnits}`,
      revenus_totaux_encaisses: Number(totalRevenuePaid.toFixed(2)),
      revenus_par_mois: revenueByMonth,
      paiements_en_retard_periode: latePaymentsCount,
      depenses_totales: Number(totalExpenses.toFixed(2)),
      depenses_par_mois: expensesByMonth,
      depenses_par_categorie: expensesByCategory,
      depenses_par_immeuble: expensesByBuilding,
      frais_gestion_portail_payes: Number(totalManagementFees.toFixed(2)),
      taux_gestion_pct: owner.management_rate,
      plafond_depenses_actuel: owner.spending_cap,
      nombre_depenses_dans_periode: Array.isArray(expenses) ? expenses.length : 0,
    };

    const contentParts = [
      {
        type: "text",
        text: `Tu es le Copilote financier de "Portail" pour le propriétaire ${owner.full_name}. Voici des agrégats DÉJÀ CALCULÉS (déterministiquement, pas par toi) sur ses ${LOOKBACK_MONTHS} derniers mois :\n\n${JSON.stringify(aggregates, null, 2)}\n\nRègles strictes :\n- Réponds UNIQUEMENT à partir des chiffres ci-dessus. N'invente et ne recalcule jamais un montant qui n'y figure pas déjà.\n- Si la question porte sur une donnée absente de ces agrégats (ex: une période hors de la fenêtre de ${LOOKBACK_MONTHS} mois, ou un détail trop fin), dis-le clairement plutôt que d'estimer.\n- Réponds en français, de façon concise (3-5 phrases), avec les chiffres exacts en dollars.\n\nQuestion du propriétaire : "${question}"`,
      },
    ];

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
        max_tokens: 500,
        messages: [{ role: "user", content: contentParts }],
      }),
    });
    const aiData = await aiRes.json();
    if (!aiRes.ok) {
      console.error("Anthropic API error", aiRes.status, JSON.stringify(aiData));
      await fetch(`${supabaseUrl}/rest/v1/ai_run_log`, {
        method: "POST", headers: adminHeaders,
        body: JSON.stringify({
          function_name: "ask-finances", trigger_source: "owner_portal", entity_type: "owners", entity_id: owner.id,
          prompt_version: PROMPT_VERSION, model_version: MODEL_VERSION, input_summary: question,
          duration_ms: Date.now() - aiStartedAt, error: `anthropic_api_error ${aiRes.status}`,
        }),
      }).catch(() => null);
      return new Response(JSON.stringify({ error: "Erreur du service IA, réessaie dans un instant." }), { status: 502, headers: corsHeaders });
    }
    const answer = aiData.content?.[0]?.text ?? "Désolé, je n'ai pas pu générer de réponse.";

    await fetch(`${supabaseUrl}/rest/v1/ai_run_log`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        function_name: "ask-finances",
        trigger_source: "owner_portal",
        entity_type: "owners",
        entity_id: owner.id,
        prompt_version: PROMPT_VERSION,
        model_version: MODEL_VERSION,
        input_summary: question,
        output_summary: answer.slice(0, 300),
        duration_ms: Date.now() - aiStartedAt,
        input_tokens: aiData?.usage?.input_tokens ?? null,
        output_tokens: aiData?.usage?.output_tokens ?? null,
        automatic_action_taken: "reponse_a_partir_d_agregats_precalcules",
      }),
    }).catch((e) => console.error("Failed to write ai_run_log", e));

    return new Response(JSON.stringify({ answer }), { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error("ask-finances unexpected error", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
