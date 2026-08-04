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

    const expensesRes = await fetch(
      `${supabaseUrl}/rest/v1/expenses?building_id=in.${buildingFilter}&expense_date=gte.${period_start}&expense_date=lte.${period_end}&select=amount`,
      { headers: adminHeaders },
    );
    const expenses = await expensesRes.json();
    const expensesTotal = expenses.reduce((sum: number, e: any) => sum + Number(e.amount || 0), 0);

    const woRes = await fetch(
      `${supabaseUrl}/rest/v1/work_orders?unit_id=in.${unitFilter}&select=status,created_at`,
      { headers: adminHeaders },
    );
    const workOrders = await woRes.json();
    const workOrdersCompleted = workOrders.filter((w: any) =>
      w.status === "completed" && w.created_at >= period_start && w.created_at <= period_end + "T23:59:59"
    ).length;
    const workOrdersInProgress = workOrders.filter((w: any) => w.status === "assigned" || w.status === "in_progress").length;

    const managementFee = Math.round(rentReceived * (Number(owner.management_rate || 0) / 100) * 100) / 100;
    const netDueToOwner = Math.round((rentReceived - expensesTotal - managementFee) * 100) / 100;

    const prompt = `Tu es l'assistant financier de "Portail", une entreprise de gestion immobilière résidentielle au Québec. Rédige un résumé court (2-4 phrases) du rapport mensuel d'un propriétaire, en français, ton clair et factuel, dans le style de cet exemple :

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
        max_tokens: 400,
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
        occupancy_rate: occupancyRate,
        expenses_total: expensesTotal,
        work_orders_completed: workOrdersCompleted,
        work_orders_in_progress: workOrdersInProgress,
        management_fee: managementFee,
        net_due_to_owner: netDueToOwner,
        renewals_upcoming: renewalsUpcoming,
        summary,
      }),
    });

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500 });
  }
});
