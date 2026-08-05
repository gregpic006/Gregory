// Rapprochement bancaire par import CSV (pas de connexion bancaire en
// temps réel — nécessiterait Plaid/Flinks). Le matching (montant,
// locataire, bail, mois, doublons) est entièrement déterministe ;
// l'IA sert uniquement à suggérer une piste pour les dépôts dont la
// description bancaire ne permet aucune correspondance automatique.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function daysBetween(d1: string, d2: string): number {
  return Math.round((new Date(d2).getTime() - new Date(d1).getTime()) / 86400000);
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

    const logAudit = (action: string, entityType: string, entityId: string | null, details: Record<string, unknown>) =>
      fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ actor_type: "admin", actor_id: userId, action, entity_type: entityType, entity_id: entityId, details }),
      });

    const body = await req.json().catch(() => ({}));
    const action = body.action || "list";

    if (action === "list") {
      const { owner_id } = body;
      if (!owner_id) {
        return new Response(JSON.stringify({ error: "owner_id manquant" }), { status: 400, headers: corsHeaders });
      }
      const res = await fetch(
        `${supabaseUrl}/rest/v1/bank_transactions?owner_id=eq.${owner_id}&select=*,matched_payment:matched_payment_id(amount,due_date),ai_suggested_tenant:ai_suggested_tenant_id(full_name)&order=transaction_date.desc`,
        { headers: adminHeaders },
      );
      return new Response(JSON.stringify({ transactions: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "import_csv") {
      const { owner_id, rows } = body;
      if (!owner_id || !Array.isArray(rows)) {
        return new Response(JSON.stringify({ error: "owner_id et rows requis" }), { status: 400, headers: corsHeaders });
      }

      const buildingsRes = await fetch(`${supabaseUrl}/rest/v1/buildings?owner_id=eq.${owner_id}&select=id`, { headers: adminHeaders });
      const buildings = await buildingsRes.json();
      const buildingIds = buildings.map((b: any) => b.id);
      const buildingFilter = buildingIds.length ? `(${buildingIds.join(",")})` : "(00000000-0000-0000-0000-000000000000)";

      const unitsRes = await fetch(`${supabaseUrl}/rest/v1/units?building_id=in.${buildingFilter}&select=id`, { headers: adminHeaders });
      const units = await unitsRes.json();
      const unitIds = units.map((u: any) => u.id);
      const unitFilter = unitIds.length ? `(${unitIds.join(",")})` : "(00000000-0000-0000-0000-000000000000)";

      const leasesRes = await fetch(`${supabaseUrl}/rest/v1/leases?unit_id=in.${unitFilter}&select=id,tenant_id,monthly_rent,tenants(full_name)`, { headers: adminHeaders });
      const leases = await leasesRes.json();
      const leaseIds = leases.map((l: any) => l.id);
      const leaseFilter = leaseIds.length ? `(${leaseIds.join(",")})` : "(00000000-0000-0000-0000-000000000000)";

      const paymentsRes = await fetch(`${supabaseUrl}/rest/v1/payments?lease_id=in.${leaseFilter}&status=in.(pending,late)&select=*`, { headers: adminHeaders });
      const candidatePayments: any[] = await paymentsRes.json();

      const fortyFiveDaysAgo = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
      const recentPaidRes = await fetch(`${supabaseUrl}/rest/v1/payments?lease_id=in.${leaseFilter}&status=eq.paid&paid_date=gte.${fortyFiveDaysAgo}&select=*`, { headers: adminHeaders });
      const recentPaid: any[] = await recentPaidRes.json();

      const tenantNames: string[] = leases.map((l: any) => l.tenants?.full_name).filter(Boolean);
      const tenantIdByName = new Map(leases.map((l: any) => [l.tenants?.full_name, l.tenant_id]));

      const results = [];
      for (const row of rows) {
        const amount = Number(row.amount);
        const txDate = row.date;
        const description = row.description || "";
        if (!txDate || !(amount > 0)) continue; // ignore retraits/frais, lignes invalides

        let matchStatus = "unmatched";
        let matchedPaymentId: string | null = null;
        let note: string | null = null;

        const dup = recentPaid.find((p: any) => Number(p.amount) === amount && p.paid_date && Math.abs(daysBetween(p.paid_date, txDate)) <= 3);
        const exactIdx = candidatePayments.findIndex((p: any) => Number(p.amount) === amount && Math.abs(daysBetween(p.due_date, txDate)) <= 10);

        if (exactIdx !== -1) {
          const payment = candidatePayments[exactIdx];
          matchStatus = "matched";
          matchedPaymentId = payment.id;
          candidatePayments.splice(exactIdx, 1);
          await fetch(`${supabaseUrl}/rest/v1/payments?id=eq.${payment.id}`, {
            method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "paid", paid_date: txDate }),
          });
        } else if (dup) {
          matchStatus = "duplicate";
          matchedPaymentId = dup.id;
          note = `Un paiement du même montant (${amount} $) a déjà été reçu le ${dup.paid_date} pour ce bail — dépôt possiblement en double.`;
        } else {
          const closeIdx = candidatePayments.findIndex((p: any) => Math.abs(daysBetween(p.due_date, txDate)) <= 10);
          if (closeIdx !== -1) {
            const payment = candidatePayments[closeIdx];
            matchedPaymentId = payment.id;
            if (amount < Number(payment.amount)) {
              matchStatus = "partial";
              note = `Paiement partiel : ${amount} $ reçu sur ${payment.amount} $ attendu.`;
            } else {
              matchStatus = "overpaid";
              candidatePayments.splice(closeIdx, 1);
              await fetch(`${supabaseUrl}/rest/v1/payments?id=eq.${payment.id}`, {
                method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "paid", paid_date: txDate }),
              });
              note = `Excédent de ${Math.round((amount - Number(payment.amount)) * 100) / 100} $ par rapport au loyer attendu (${payment.amount} $).`;
            }
          }
        }

        let aiSuggestedTenantId: string | null = null;
        let aiConfidence: number | null = null;
        if (matchStatus === "unmatched" && tenantNames.length && anthropicKey) {
          const aiStartedAt = Date.now();
          try {
            const prompt = `Tu es l'assistant de rapprochement bancaire de "Portail". Voici un dépôt bancaire dont l'origine n'est pas claire à partir des données connues (montant, date).

Description bancaire : "${description}"
Montant : ${amount} $
Date : ${txDate}

Locataires actifs de ce propriétaire : ${tenantNames.join(", ")}

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après):
{
  "suggested_tenant_name": "le nom exact d'un locataire de la liste ci-dessus si la description bancaire y fait clairement référence, sinon null — ne devine jamais sans indice textuel réel",
  "confidence": un nombre entre 0 et 100,
  "note": "une phrase expliquant ton raisonnement, ou pourquoi ce dépôt ne peut pas être identifié"
}`;
            const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
              body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
            });
            const aiData = await aiRes.json();
            const rawText = aiData.content?.[0]?.text ?? "{}";
            const parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
            if (parsed.suggested_tenant_name && tenantIdByName.has(parsed.suggested_tenant_name)) {
              aiSuggestedTenantId = tenantIdByName.get(parsed.suggested_tenant_name) ?? null;
            }
            aiConfidence = typeof parsed.confidence === "number" ? parsed.confidence : null;
            note = parsed.note ?? note;

            await fetch(`${supabaseUrl}/rest/v1/ai_run_log`, {
              method: "POST", headers: adminHeaders,
              body: JSON.stringify({
                function_name: "reconcile-bank-transactions", trigger_source: "admin_csv_import", entity_type: "bank_transactions",
                prompt_version: "bank-reconciliation-v1", model_version: "claude-haiku-4-5-20251001",
                input_summary: `${description} — ${amount} $`, output_summary: parsed.suggested_tenant_name ?? "aucune piste",
                confidence: aiConfidence, needs_escalation: aiConfidence == null || aiConfidence < 70,
                duration_ms: Date.now() - aiStartedAt,
                input_tokens: aiData?.usage?.input_tokens ?? null, output_tokens: aiData?.usage?.output_tokens ?? null,
                automatic_action_taken: "suggestion_seulement_aucune_application_automatique",
              }),
            }).catch(() => null);
          } catch (e) {
            console.error("AI bank description suggestion failed", e);
          }
        }

        const insertRes = await fetch(`${supabaseUrl}/rest/v1/bank_transactions`, {
          method: "POST",
          headers: { ...adminHeaders, Prefer: "return=representation" },
          body: JSON.stringify({
            owner_id, transaction_date: txDate, description, amount,
            match_status: matchStatus, matched_payment_id: matchedPaymentId,
            ai_suggested_tenant_id: aiSuggestedTenantId, ai_suggestion_note: note, ai_confidence: aiConfidence,
          }),
        });
        const [inserted] = await insertRes.json().catch(() => [null]);
        if (inserted) results.push(inserted);
      }

      await logAudit("bank_reconciliation.import", "bank_transactions", null, { owner_id, count: rows.length });
      return new Response(JSON.stringify({ ok: true, results }), { status: 200, headers: corsHeaders });
    }

    if (action === "confirm_match") {
      const { transaction_id, payment_id } = body;
      if (!transaction_id || !payment_id) {
        return new Response(JSON.stringify({ error: "Paramètres manquants" }), { status: 400, headers: corsHeaders });
      }
      const txRes = await fetch(`${supabaseUrl}/rest/v1/bank_transactions?id=eq.${transaction_id}&select=*`, { headers: adminHeaders });
      const [tx] = await txRes.json();
      if (!tx) {
        return new Response(JSON.stringify({ error: "Transaction introuvable" }), { status: 404, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/payments?id=eq.${payment_id}`, {
        method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "paid", paid_date: tx.transaction_date }),
      });
      await fetch(`${supabaseUrl}/rest/v1/bank_transactions?id=eq.${transaction_id}`, {
        method: "PATCH", headers: adminHeaders,
        body: JSON.stringify({ match_status: "matched", matched_payment_id: payment_id, reconciled_by: userId, reconciled_at: new Date().toISOString() }),
      });
      await logAudit("bank_reconciliation.manual_match", "bank_transactions", transaction_id, { payment_id });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "ignore_transaction") {
      const { transaction_id } = body;
      if (!transaction_id) {
        return new Response(JSON.stringify({ error: "transaction_id manquant" }), { status: 400, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/bank_transactions?id=eq.${transaction_id}`, {
        method: "PATCH", headers: adminHeaders,
        body: JSON.stringify({ match_status: "ignored", reconciled_by: userId, reconciled_at: new Date().toISOString() }),
      });
      await logAudit("bank_reconciliation.ignore", "bank_transactions", transaction_id, {});
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    console.error("reconcile-bank-transactions unexpected error", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
