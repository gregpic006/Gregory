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
