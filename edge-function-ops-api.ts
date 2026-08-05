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
    const action = body.action || "list_service_requests";

    if (action === "list_service_requests") {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/service_requests?status=eq.open&select=*,units(unit_number,buildings(address)),tenants(full_name)&order=created_at.desc`,
        { headers: adminHeaders },
      );
      return new Response(JSON.stringify({ service_requests: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "list_work_orders") {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/work_orders?status=in.(open,assigned,in_progress)&select=*,units(unit_number,building_id,buildings(address)),workers(name,phone)&order=created_at.desc`,
        { headers: adminHeaders },
      );
      return new Response(JSON.stringify({ work_orders: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "list_workers") {
      const res = await fetch(`${supabaseUrl}/rest/v1/workers?select=*&order=name.asc`, { headers: adminHeaders });
      return new Response(JSON.stringify({ workers: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "create_work_order") {
      const { service_request_id, unit_id, worker_id, description, worker_pay, appointment_at, entry_permission, billing_terms, due_by } = body;
      if (!unit_id || !worker_id || !description || !worker_pay) {
        return new Response(JSON.stringify({ error: "Champs manquants" }), { status: 400, headers: corsHeaders });
      }
      const coordinationFee = Math.round(Number(worker_pay) * 0.10 * 100) / 100;
      const estimatedCost = Math.round((Number(worker_pay) + coordinationFee) * 100) / 100;

      const woInsertRes = await fetch(`${supabaseUrl}/rest/v1/work_orders`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "return=representation" },
        body: JSON.stringify({
          service_request_id: service_request_id || null,
          unit_id, worker_id, description,
          worker_pay: Number(worker_pay),
          coordination_fee: coordinationFee,
          estimated_cost: estimatedCost,
          status: "assigned",
          appointment_at: appointment_at || null,
          entry_permission: entry_permission || null,
          billing_terms: billing_terms || null,
          due_by: due_by || null,
        }),
      });
      const [newWorkOrder] = await woInsertRes.json();
      if (service_request_id) {
        await fetch(`${supabaseUrl}/rest/v1/service_requests?id=eq.${service_request_id}`, {
          method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "in_progress", pending_reassessment: false, reassessment_due: null }),
        });
      }
      await logAudit("work_order.create", "work_orders", newWorkOrder?.id ?? null, { worker_id, worker_pay: Number(worker_pay), coordination_fee: coordinationFee, estimated_cost: estimatedCost });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "reassign_work_order") {
      const { work_order_id, worker_id } = body;
      await fetch(`${supabaseUrl}/rest/v1/work_orders?id=eq.${work_order_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ worker_id, worker_notified: false }),
      });
      await logAudit("work_order.reassign", "work_orders", work_order_id, { new_worker_id: worker_id });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "complete_work_order") {
      const { work_order_id, actual_cost, receipt_base64, receipt_filename, receipt_content_type } = body;

      const woRes = await fetch(
        `${supabaseUrl}/rest/v1/work_orders?id=eq.${work_order_id}&select=description,service_request_id,unit_id,units(building_id,buildings(owner_id))`,
        { headers: adminHeaders },
      );
      const [wo] = await woRes.json();
      if (!wo) {
        return new Response(JSON.stringify({ error: "Travail introuvable" }), { status: 404, headers: corsHeaders });
      }
      const buildingId = wo.units?.building_id;
      const ownerId = wo.units?.buildings?.owner_id;

      let receiptDocumentId: string | null = null;
      if (receipt_base64 && ownerId) {
        const path = `${ownerId}/${Date.now()}-${receipt_filename || "recu"}`;
        const bytes = Uint8Array.from(atob(receipt_base64), (c) => c.charCodeAt(0));
        const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/documents/${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${serviceRoleKey}`,
            apikey: serviceRoleKey ?? "",
            "Content-Type": receipt_content_type || "application/octet-stream",
          },
          body: bytes,
        });
        if (uploadRes.ok) {
          const docRes = await fetch(`${supabaseUrl}/rest/v1/documents`, {
            method: "POST",
            headers: { ...adminHeaders, Prefer: "return=representation" },
            body: JSON.stringify({
              owner_id: ownerId,
              building_id: buildingId,
              title: `Facture — ${wo.description}`,
              doc_type: "facture",
              file_url: path,
            }),
          });
          const [doc] = await docRes.json();
          receiptDocumentId = doc?.id || null;
        }
      }

      await fetch(`${supabaseUrl}/rest/v1/work_orders?id=eq.${work_order_id}`, {
        method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "completed" }),
      });
      if (wo.service_request_id) {
        await fetch(`${supabaseUrl}/rest/v1/service_requests?id=eq.${wo.service_request_id}`, {
          method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "closed" }),
        });
      }
      await fetch(`${supabaseUrl}/rest/v1/expenses`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          work_order_id, building_id: buildingId, unit_id: wo.unit_id,
          description: wo.description,
          amount: Number(actual_cost),
          expense_date: new Date().toISOString().slice(0, 10),
          receipt_document_id: receiptDocumentId,
        }),
      });

      await logAudit("work_order.complete", "work_orders", work_order_id, { actual_cost: Number(actual_cost), receipt_document_id: receiptDocumentId });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "list_late_payments") {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/payments?status=eq.late&select=*,leases(monthly_rent,tenants(full_name,email),units(unit_number,buildings(address)))&order=due_date.asc`,
        { headers: adminHeaders },
      );
      return new Response(JSON.stringify({ payments: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "toggle_payment_reminder_pause") {
      const { payment_id, paused } = body;
      if (!payment_id) {
        return new Response(JSON.stringify({ error: "payment_id manquant" }), { status: 400, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/payments?id=eq.${payment_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ reminder_paused: !!paused }),
      });
      await logAudit(paused ? "payment_reminder.paused" : "payment_reminder.resumed", "payments", payment_id, { paused: !!paused });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
