const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function describeOnboardingGaps(c: any): string[] {
  const gaps: string[] = [];
  if (c.missing_phone) gaps.push("téléphone manquant");
  if (c.missing_buildings) gaps.push("aucun immeuble");
  if (c.missing_units) gaps.push("immeuble sans unité");
  if (c.units_missing_rent_count > 0) gaps.push(`${c.units_missing_rent_count} unité(s) sans loyer`);
  if (c.occupied_units_missing_lease_count > 0) gaps.push(`${c.occupied_units_missing_lease_count} unité(s) occupée(s) sans bail actif`);
  if (c.active_leases_missing_tenant_contact_count > 0) gaps.push(`${c.active_leases_missing_tenant_contact_count} locataire(s) sans coordonnées`);
  if (c.active_leases_missing_bail_doc_count > 0) gaps.push(`${c.active_leases_missing_bail_doc_count} bail(aux) sans copie téléversée`);
  return gaps;
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
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const userRes = await fetch(`${supabaseUrl}/rest/v1/users?id=eq.${userId}&select=is_admin`, {
      headers: adminHeaders,
    });
    const userRows = await userRes.json();
    if (!userRows?.[0]?.is_admin) {
      return new Response(JSON.stringify({ error: "Accès refusé — compte non admin" }), { status: 403, headers: corsHeaders });
    }

    const body = await req.json().catch(() => ({}));

    if (body.action === "send_onboarding_reminder_now") {
      const { owner_id } = body;
      if (!owner_id) {
        return new Response(JSON.stringify({ error: "owner_id manquant" }), { status: 400, headers: corsHeaders });
      }
      const res = await fetch(`${supabaseUrl}/functions/v1/send-onboarding-reminder`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR",
          apikey: "sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR",
        },
        body: JSON.stringify({ owner_id }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        return new Response(JSON.stringify({ error: result?.error || "Échec de l'envoi du rappel" }), { status: 502, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ actor_type: "admin", actor_id: userId, action: "onboarding.reminder_sent_manual", entity_type: "owners", entity_id: owner_id, details: result }),
      });
      return new Response(JSON.stringify({ ok: true, ...result }), { status: 200, headers: corsHeaders });
    }

    if (body.action === "resolve_dissatisfaction_signal") {
      const { signal_id, resolution_note } = body;
      if (!signal_id) {
        return new Response(JSON.stringify({ error: "signal_id manquant" }), { status: 400, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/dissatisfaction_signals?id=eq.${signal_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ resolved: true, resolved_at: new Date().toISOString(), resolution_note: resolution_note || null }),
      });
      await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ actor_type: "admin", actor_id: userId, action: "dissatisfaction.resolved", entity_type: "dissatisfaction_signals", entity_id: signal_id, details: { resolution_note: resolution_note || null } }),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (body.action === "update_anomaly") {
      const { anomaly_id, status } = body;
      await fetch(`${supabaseUrl}/rest/v1/financial_anomalies?id=eq.${anomaly_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ status }),
      });
      await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ actor_type: "admin", actor_id: userId, action: "anomaly.update", entity_type: "financial_anomalies", entity_id: anomaly_id, details: { new_status: status } }),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    const ownersRes = await fetch(
      `${supabaseUrl}/rest/v1/owners?select=id,full_name,phone,management_rate,spending_cap,buildings(id,address,units(id,rent,status))`,
      { headers: adminHeaders },
    );
    const owners = await ownersRes.json();

    const approvalsRes = await fetch(
      `${supabaseUrl}/rest/v1/approvals?status=eq.pending&select=id`,
      { headers: adminHeaders },
    );
    const pendingApprovals = await approvalsRes.json();

    const inquiriesRes = await fetch(
      `${supabaseUrl}/rest/v1/inquiries?status=eq.new&select=id`,
      { headers: adminHeaders },
    );
    const newInquiries = await inquiriesRes.json();

    const anomaliesRes = await fetch(
      `${supabaseUrl}/rest/v1/financial_anomalies?status=eq.open&select=*,owners(full_name)&order=severity.asc,created_at.desc`,
      { headers: adminHeaders },
    );
    const anomalies = await anomaliesRes.json();

    // ============================================================
    // CENTRE DE COMMANDEMENT QUOTIDIEN
    // ============================================================
    // Une seule vue agrégée pour tout ce qui demande l'attention de
    // l'admin aujourd'hui, plutôt que dix onglets séparés. Tout est lu
    // directement (aucun calcul inventé) — chaque catégorie pointe vers
    // les vraies lignes déjà gérées ailleurs dans le portail.
    const todayStr = new Date().toISOString().slice(0, 10);
    const in30days = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const in60days = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);

    const [
      urgentServiceRequests,
      needsReviewServiceRequests,
      docsNeedingValidation,
      workerDecisionsNeeded,
      blockedReassessment,
      allDeclinedWorkOrders,
      pendingWorkerResponses,
      latePayments,
      leaseRenewals,
      allMessages,
      expiringDocs,
      prospectsToFollowUp,
    ] = await Promise.all([
      fetch(`${supabaseUrl}/rest/v1/service_requests?status=neq.closed&or=(safety_override.eq.true,ai_urgency.eq.urgence)&select=id,description,ai_urgency,safety_flags,units(unit_number,buildings(address))`, { headers: adminHeaders }).then((r) => r.json()),
      fetch(`${supabaseUrl}/rest/v1/service_requests?status=neq.closed&ai_needs_review=eq.true&safety_override=eq.false&select=id,description,ai_confidence,units(unit_number,buildings(address))`, { headers: adminHeaders }).then((r) => r.json()),
      fetch(`${supabaseUrl}/rest/v1/documents?ai_needs_human_validation=eq.true&select=id,title,owners(full_name)`, { headers: adminHeaders }).then((r) => r.json()),
      fetch(`${supabaseUrl}/rest/v1/work_orders?worker_response=in.(proposed_other_time,info_requested)&select=id,description,worker_response,worker_response_note,workers(name)`, { headers: adminHeaders }).then((r) => r.json()),
      fetch(`${supabaseUrl}/rest/v1/service_requests?pending_reassessment=eq.true&select=id,description,reassessment_due,units(unit_number,buildings(address))`, { headers: adminHeaders }).then((r) => r.json()),
      fetch(`${supabaseUrl}/rest/v1/work_orders?response_escalated=eq.true&worker_response=eq.declined&select=id,description,units(unit_number,buildings(address))`, { headers: adminHeaders }).then((r) => r.json()),
      fetch(`${supabaseUrl}/rest/v1/work_orders?worker_response=eq.pending&worker_notified=eq.true&select=id,description,worker_notified_at,workers(name)`, { headers: adminHeaders }).then((r) => r.json()),
      fetch(`${supabaseUrl}/rest/v1/payments?status=eq.late&select=id,amount,due_date,leases(tenants(full_name),units(unit_number,buildings(address)))`, { headers: adminHeaders }).then((r) => r.json()),
      fetch(`${supabaseUrl}/rest/v1/leases?status=eq.active&end_date=lte.${in60days}&select=id,end_date,tenants(full_name),units(unit_number,buildings(address))`, { headers: adminHeaders }).then((r) => r.json()),
      fetch(`${supabaseUrl}/rest/v1/messages?select=id,owner_id,sender,body,created_at,owners(full_name)&order=created_at.desc`, { headers: adminHeaders }).then((r) => r.json()),
      fetch(`${supabaseUrl}/rest/v1/documents?ai_expiry_date=lte.${in30days}&ai_expiry_date=gte.${todayStr}&select=id,title,ai_expiry_date,owners(full_name)`, { headers: adminHeaders }).then((r) => r.json()),
      fetch(`${supabaseUrl}/rest/v1/prospects?next_followup_date=lte.${todayStr}&stage=not.in.(signed,lost)&select=id,full_name,next_followup_date,stage`, { headers: adminHeaders }).then((r) => r.json()),
    ]);

    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    const [visitsToSchedule, visitsAwaitingResponse, visitsNeedingOutcome] = await Promise.all([
      fetch(`${supabaseUrl}/rest/v1/inquiries?type=eq.visite&status=eq.new&select=id,full_name,units(unit_number,buildings(address))`, { headers: adminHeaders }).then((r) => r.json()),
      fetch(`${supabaseUrl}/rest/v1/visits?status=eq.proposed&created_at=lte.${twoDaysAgo}&select=id,prospect_name,proposed_at,response_note,units(unit_number,buildings(address))`, { headers: adminHeaders }).then((r) => r.json()),
      fetch(`${supabaseUrl}/rest/v1/visits?status=eq.confirmed&proposed_at=lt.${new Date().toISOString()}&select=id,prospect_name,proposed_at,units(unit_number,buildings(address))`, { headers: adminHeaders }).then((r) => r.json()),
    ]);

    const stuckRepairCasesRes = await fetch(
      `${supabaseUrl}/rest/v1/audit_log?or=(action.like.repair_case.stuck_*,action.eq.repair_case.tenant_reopened)&created_at=gte.${new Date(Date.now() - 24 * 3600000).toISOString()}&select=id,action,entity_type,entity_id,details,created_at&order=created_at.desc`,
      { headers: adminHeaders },
    );
    const stuckRepairCases = await stuckRepairCasesRes.json().catch(() => []);

    const lowConfidenceAiRunsRes = await fetch(
      `${supabaseUrl}/rest/v1/ai_run_log?needs_escalation=eq.true&created_at=gte.${new Date(Date.now() - 24 * 3600000).toISOString()}&select=id,function_name,entity_type,entity_id,input_summary,confidence,error,created_at&order=created_at.desc&limit=20`,
      { headers: adminHeaders },
    );
    const lowConfidenceAiRuns = await lowConfidenceAiRunsRes.json().catch(() => []);

    const workerVerificationIssuesRes = await fetch(
      `${supabaseUrl}/rest/v1/audit_log?action=in.(worker_verification.non_compliant,worker_verification.expiring_soon)&created_at=gte.${new Date(Date.now() - 24 * 3600000).toISOString()}&select=id,action,entity_id,details,created_at&order=created_at.desc`,
      { headers: adminHeaders },
    );
    const workerVerificationIssues = await workerVerificationIssuesRes.json().catch(() => []);

    const dissatisfactionSignalsRes = await fetch(
      `${supabaseUrl}/rest/v1/dissatisfaction_signals?escalated=eq.true&resolved=eq.false&select=*&order=created_at.desc`,
      { headers: adminHeaders },
    );
    const dissatisfactionSignals = await dissatisfactionSignalsRes.json().catch(() => []);

    const onboardingChecklistRes = await fetch(
      `${supabaseUrl}/rest/v1/owner_onboarding_checklist?onboarding_completed_at=is.null&select=*`,
      { headers: adminHeaders },
    );
    const onboardingChecklist = await onboardingChecklistRes.json().catch(() => []);
    const onboardingIncomplet = (Array.isArray(onboardingChecklist) ? onboardingChecklist : [])
      .map((c: any) => ({ owner_id: c.owner_id, full_name: c.full_name, gaps: describeOnboardingGaps(c) }))
      .filter((o: any) => o.gaps.length > 0);

    const lastMessageByOwner = new Map<string, any>();
    if (Array.isArray(allMessages)) {
      for (const m of allMessages) {
        if (!lastMessageByOwner.has(m.owner_id)) lastMessageByOwner.set(m.owner_id, m);
      }
    }
    const unansweredMessages = [...lastMessageByOwner.values()].filter((m) => m.sender === "owner");

    const commandCenter = {
      urgences: urgentServiceRequests,
      decisions_requises: {
        approbations_en_attente: pendingApprovals,
        demandes_a_valider: needsReviewServiceRequests,
        documents_a_valider: docsNeedingValidation,
        decisions_travailleurs: workerDecisionsNeeded,
      },
      dossiers_bloques: {
        refuses_a_reevaluer: blockedReassessment,
        tous_travailleurs_ont_refuse: allDeclinedWorkOrders,
      },
      travailleurs_sans_reponse: pendingWorkerResponses,
      loyers_en_retard: latePayments,
      baux_a_renouveler: leaseRenewals,
      messages_sans_reponse: unansweredMessages,
      documents_expirant_bientot: expiringDocs,
      prospects_a_relancer: prospectsToFollowUp,
      anomalies_financieres: anomalies,
      dossiers_reparation_stagnants: stuckRepairCases,
      ia_faible_confiance: lowConfidenceAiRuns,
      onboarding_incomplet: onboardingIncomplet,
      travailleurs_a_verifier: workerVerificationIssues,
      visites: {
        a_planifier: visitsToSchedule,
        sans_reponse: visitsAwaitingResponse,
        resultat_manquant: visitsNeedingOutcome,
      },
      signaux_insatisfaction: dissatisfactionSignals,
    };

    const clients = owners.map((o: any) => {
      const buildings = o.buildings || [];
      const units = buildings.flatMap((b: any) => b.units || []);
      const occupied = units.filter((u: any) => u.status === "occupied").length;
      const monthlyRevenue = units.reduce((sum: number, u: any) => sum + (Number(u.rent) || 0), 0) * (Number(o.management_rate) / 100);
      return {
        id: o.id,
        full_name: o.full_name,
        phone: o.phone,
        buildings_count: buildings.length,
        units_count: units.length,
        occupied_count: occupied,
        monthly_revenue: Math.round(monthlyRevenue * 100) / 100,
      };
    });

    const totals = {
      clients_count: clients.length,
      buildings_count: clients.reduce((s: number, c: any) => s + c.buildings_count, 0),
      units_count: clients.reduce((s: number, c: any) => s + c.units_count, 0),
      monthly_revenue: Math.round(clients.reduce((s: number, c: any) => s + c.monthly_revenue, 0) * 100) / 100,
      pending_approvals: pendingApprovals.length,
      new_inquiries: newInquiries.length,
      open_anomalies: anomalies.length,
    };

    return new Response(JSON.stringify({ totals, clients, anomalies, command_center: commandCenter }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
