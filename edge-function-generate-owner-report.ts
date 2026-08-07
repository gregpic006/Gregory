Deno.serve(async (req) => {
  try {
    const { owner_id, period_start, period_end } = await req.json();

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const ownerRes = await fetch(
      `${supabaseUrl}/rest/v1/owners?id=eq.${owner_id}&select=*`,
      { headers: adminHeaders },
    );
    const [owner] = await ownerRes.json();
    if (!owner) {
      return new Response(JSON.stringify({ ok: false, error: "owner not found" }), { status: 404 });
    }

    const buildingsRes = await fetch(
      `${supabaseUrl}/rest/v1/buildings?owner_id=eq.${owner_id}&select=id`,
      { headers: adminHeaders },
    );
    const buildings = await buildingsRes.json();
    const buildingIds: string[] = buildings.map((b: any) => b.id);

    if (buildingIds.length === 0) {
      return new Response(JSON.stringify({ ok: true, skipped: "no buildings" }), { status: 200 });
    }
    const buildingFilter = `(${buildingIds.join(",")})`;

    const unitsRes = await fetch(
      `${supabaseUrl}/rest/v1/units?building_id=in.${buildingFilter}&select=id,status`,
      { headers: adminHeaders },
    );
    const units = await unitsRes.json();
    const unitIds: string[] = units.map((u: any) => u.id);
    const unitFilter = unitIds.length ? `(${unitIds.join(",")})` : "(00000000-0000-0000-0000-000000000000)";

    const occupiedCount = units.filter((u: any) => u.status === "occupied").length;
    const occupancyRate = units.length ? Math.round((occupiedCount / units.length) * 10000) / 100 : 0;

    const leasesRes = await fetch(
      `${supabaseUrl}/rest/v1/leases?unit_id=in.${unitFilter}&status=eq.active&select=id,monthly_rent,end_date`,
      { headers: adminHeaders },
    );
    const leases = await leasesRes.json();
    const leaseIds: string[] = leases.map((l: any) => l.id);
    const leaseFilter = leaseIds.length ? `(${leaseIds.join(",")})` : "(00000000-0000-0000-0000-000000000000)";
    const rentExpected = leases.reduce((sum: number, l: any) => sum + Number(l.monthly_rent || 0), 0);

    const sixtyDaysOut = new Date(period_end);
    sixtyDaysOut.setDate(sixtyDaysOut.getDate() + 60);
    const renewalsUpcoming = leases.filter((l: any) => l.end_date && l.end_date <= sixtyDaysOut.toISOString().slice(0, 10)).length;

    const paymentsRes = await fetch(
      `${supabaseUrl}/rest/v1/payments?lease_id=in.${leaseFilter}&due_date=gte.${period_start}&due_date=lte.${period_end}&select=amount,status`,
      { headers: adminHeaders },
    );
    const payments = await paymentsRes.json();
    const rentReceived = payments.filter((p: any) => p.status === "paid").reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0);
    const lateCount = payments.filter((p: any) => p.status === "late").length;
    const lateAmount = Math.round(payments.filter((p: any) => p.status === "late").reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0) * 100) / 100;

    const expensesRes = await fetch(
      `${supabaseUrl}/rest/v1/expenses?building_id=in.${buildingFilter}&expense_date=gte.${period_start}&expense_date=lte.${period_end}&select=id,description,amount,expense_date,receipt_document_id,work_order_id`,
      { headers: adminHeaders },
    );
    const expenses = await expensesRes.json();
    const expensesTotal = expenses.reduce((sum: number, e: any) => sum + Number(e.amount || 0), 0);

    // Factures sans reçu — actionnable directement par le propriétaire ou l'admin.
    const missingReceipts = expenses
      .filter((e: any) => !e.receipt_document_id)
      .map((e: any) => ({ expense_id: e.id, description: e.description, amount: Number(e.amount), expense_date: e.expense_date }));

    const woRes = await fetch(
      `${supabaseUrl}/rest/v1/work_orders?unit_id=in.${unitFilter}&select=id,description,status,created_at,estimated_cost,coordination_fee`,
      { headers: adminHeaders },
    );
    const workOrders = await woRes.json();
    const workOrdersCompleted = workOrders.filter((w: any) =>
      w.status === "completed" && w.created_at >= period_start && w.created_at <= period_end + "T23:59:59"
    ).length;
    const workOrdersInProgress = workOrders.filter((w: any) => w.status === "assigned" || w.status === "in_progress").length;

    // Travaux ayant dépassé leur estimation initiale — comparaison faite
    // en code, jamais estimée par l'IA.
    const workOrdersById = new Map(workOrders.map((w: any) => [w.id, w]));
    const overEstimateWorkOrders = expenses
      .filter((e: any) => e.work_order_id && workOrdersById.has(e.work_order_id))
      .map((e: any) => {
        const wo = workOrdersById.get(e.work_order_id);
        const estimated = wo?.estimated_cost != null ? Number(wo.estimated_cost) : null;
        const actual = Number(e.amount);
        return estimated != null && actual > estimated
          ? { work_order_id: e.work_order_id, description: wo.description, estimated_cost: estimated, actual_cost: actual, overage: Math.round((actual - estimated) * 100) / 100 }
          : null;
      })
      .filter(Boolean);

    // Relevé structuré : "Travaux" = dépenses liées à un travail assigné
    // par Portail (worker_pay + coordination_fee déjà inclus dans le
    // montant de la dépense) ; "Dépenses" = le reste (taxes municipales,
    // assurances, etc. — jamais administré par Portail).
    const workOrderExpensesTotal = Math.round(
      expenses.filter((e: any) => e.work_order_id && workOrdersById.has(e.work_order_id)).reduce((sum: number, e: any) => sum + Number(e.amount || 0), 0) * 100,
    ) / 100;
    const otherExpensesTotal = Math.round((expensesTotal - workOrderExpensesTotal) * 100) / 100;

    const approvalsRes = await fetch(
      `${supabaseUrl}/rest/v1/approvals?owner_id=eq.${owner_id}&status=eq.pending&select=id`,
      { headers: adminHeaders },
    );
    const pendingApprovals = await approvalsRes.json().catch(() => []);

    const anomaliesRes = await fetch(
      `${supabaseUrl}/rest/v1/financial_anomalies?owner_id=eq.${owner_id}&status=eq.open&select=id`,
      { headers: adminHeaders },
    );
    const openAnomalies = await anomaliesRes.json().catch(() => []);

    const managementFee = Math.round(rentReceived * (Number(owner.management_rate || 0) / 100) * 100) / 100;
    const netDueToOwner = Math.round((rentReceived - expensesTotal - managementFee) * 100) / 100;

    // Actions concrètes attendues du propriétaire — liste déterministe,
    // pas générée par l'IA.
    const ownerActionsNeeded: string[] = [];
    if (Array.isArray(pendingApprovals) && pendingApprovals.length) ownerActionsNeeded.push(`${pendingApprovals.length} approbation(s) en attente de votre décision`);
    if (missingReceipts.length) ownerActionsNeeded.push(`${missingReceipts.length} facture(s) sans reçu à documenter`);
    if (overEstimateWorkOrders.length) ownerActionsNeeded.push(`${overEstimateWorkOrders.length} travaux ont dépassé l'estimation initiale — à valider`);
    if (lateCount > 0) ownerActionsNeeded.push(`${lateCount} paiement(s) en retard à suivre`);
    if (Array.isArray(openAnomalies) && openAnomalies.length) ownerActionsNeeded.push(`${openAnomalies.length} anomalie(s) financière(s) ouverte(s) à examiner`);

    // Comparaison avec le rapport précédent déjà généré (pas de recalcul,
    // simple lecture du dernier rapport existant).
    const prevReportRes = await fetch(
      `${supabaseUrl}/rest/v1/reports?owner_id=eq.${owner_id}&period_end=lt.${period_start}&select=rent_received,occupancy_rate,expenses_total,net_due_to_owner&order=period_end.desc&limit=1`,
      { headers: adminHeaders },
    );
    const [prevReport] = await prevReportRes.json().catch(() => [null]);

    const prompt = `Tu es l'assistant financier de "Portail", une entreprise de gestion immobilière résidentielle au Québec. Rédige un résumé court (3-5 phrases) du rapport mensuel d'un propriétaire, en français, ton clair et factuel, dans le style de cet exemple :

"L'immeuble a encaissé 98 % des loyers ce mois-ci. Une unité présente un retard de cinq jours. Deux réparations ont été complétées pour un coût total de 630 $, incluant les frais de coordination."

Chiffres du mois (${period_start} au ${period_end}) :
Loyers attendus: ${rentExpected} $
Loyers reçus: ${rentReceived} $
Paiements en retard: ${lateCount}
Taux d'occupation: ${occupancyRate} %
Dépenses totales: ${expensesTotal} $
Travaux complétés: ${workOrdersCompleted}
Travaux en cours: ${workOrdersInProgress}
Frais de gestion: ${managementFee} $
Renouvellements de bail à venir (60 jours): ${renewalsUpcoming}
Montant net à remettre au propriétaire: ${netDueToOwner} $
Factures sans reçu: ${missingReceipts.length}
Travaux ayant dépassé l'estimation: ${overEstimateWorkOrders.length}
${prevReport ? `Mois précédent — loyers reçus: ${prevReport.rent_received} $, occupation: ${prevReport.occupancy_rate} %, dépenses: ${prevReport.expenses_total} $` : "Aucun rapport précédent pour comparaison."}

RÈGLES : n'invente aucun chiffre au-delà de ceux fournis ci-dessus. Si des actions sont attendues du propriétaire (approbations, reçus manquants, dépassements), mentionne-les brièvement.

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après):
{ "summary": "le résumé rédigé" }`;

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
    let summary = "";
    try {
      summary = JSON.parse(cleaned).summary;
    } catch {
      summary = rawText;
    }

    await fetch(`${supabaseUrl}/rest/v1/reports`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        owner_id,
        period_start,
        period_end,
        rent_expected: rentExpected,
        rent_received: rentReceived,
        late_count: lateCount,
        late_amount: lateAmount,
        occupancy_rate: occupancyRate,
        expenses_total: expensesTotal,
        work_order_expenses_total: workOrderExpensesTotal,
        other_expenses_total: otherExpensesTotal,
        work_orders_completed: workOrdersCompleted,
        work_orders_in_progress: workOrdersInProgress,
        management_fee: managementFee,
        net_due_to_owner: netDueToOwner,
        renewals_upcoming: renewalsUpcoming,
        summary,
        missing_receipts_count: missingReceipts.length,
        missing_receipts: missingReceipts,
        over_estimate_count: overEstimateWorkOrders.length,
        over_estimate_work_orders: overEstimateWorkOrders,
        owner_actions_needed: ownerActionsNeeded,
        bank_reconciliation_status: "non_connecte",
        prev_rent_received: prevReport?.rent_received ?? null,
        prev_occupancy_rate: prevReport?.occupancy_rate ?? null,
        prev_expenses_total: prevReport?.expenses_total ?? null,
        prev_net_due_to_owner: prevReport?.net_due_to_owner ?? null,
      }),
    });

    // ---- Facture Portail → propriétaire (frais de gestion + coordination) ----
    // Ces montants sont déjà soustraits de net_due_to_owner ci-dessus ;
    // la facture ne fait que les formaliser pour la comptabilité du
    // propriétaire. Les taxes ne s'appliquent que si Portail a un numéro
    // de TPS/TVQ enregistré dans company_settings (vide avant le 15 août
    // 2026) — aucun changement de code à faire une fois incorporé.
    const expensesWithWorkOrder = expenses.filter((e: any) => e.work_order_id && workOrdersById.has(e.work_order_id));
    const coordinationFeesTotal = Math.round(
      expensesWithWorkOrder.reduce((sum: number, e: any) => sum + Number(workOrdersById.get(e.work_order_id)?.coordination_fee || 0), 0) * 100,
    ) / 100;

    const settingsRes = await fetch(`${supabaseUrl}/rest/v1/company_settings?id=eq.true&select=*`, { headers: adminHeaders });
    const [companySettings] = await settingsRes.json().catch(() => [null]);
    const gstRate = companySettings?.gst_number ? Number(companySettings.gst_rate || 0) : 0;
    const qstRate = companySettings?.qst_number ? Number(companySettings.qst_rate || 0) : 0;

    const invoiceSubtotal = Math.round((managementFee + coordinationFeesTotal) * 100) / 100;
    const gstAmount = Math.round(invoiceSubtotal * (gstRate / 100) * 100) / 100;
    const qstAmount = Math.round(invoiceSubtotal * (qstRate / 100) * 100) / 100;
    const invoiceTotal = Math.round((invoiceSubtotal + gstAmount + qstAmount) * 100) / 100;

    if (invoiceSubtotal > 0) {
      const yearPrefix = period_end.slice(0, 4);
      const countRes = await fetch(`${supabaseUrl}/rest/v1/invoices?invoice_number=like.PORT-${yearPrefix}-*&select=id`, { headers: adminHeaders });
      const existingInvoicesThisYear = await countRes.json().catch(() => []);
      const invoiceNumber = `PORT-${yearPrefix}-${String((Array.isArray(existingInvoicesThisYear) ? existingInvoicesThisYear.length : 0) + 1).padStart(4, "0")}`;

      await fetch(`${supabaseUrl}/rest/v1/invoices?on_conflict=owner_id,period_start,period_end`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "resolution=ignore-duplicates" },
        body: JSON.stringify({
          owner_id, invoice_number: invoiceNumber, period_start, period_end,
          management_fee_amount: managementFee, coordination_fees_amount: coordinationFeesTotal,
          subtotal: invoiceSubtotal, gst_amount: gstAmount, qst_amount: qstAmount, total_amount: invoiceTotal,
        }),
      });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    console.error("generate-owner-report unexpected error", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500 });
  }
});
