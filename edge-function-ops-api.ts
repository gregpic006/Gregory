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
    const resendKey = Deno.env.get("RESEND_API_KEY");
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
      const res = await fetch(`${supabaseUrl}/rest/v1/worker_verification_status?select=*&order=name.asc`, { headers: adminHeaders });
      return new Response(JSON.stringify({ workers: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "create_worker") {
      const { name, specialty, phone, email, rbq_license, requires_rbq } = body;
      if (!name) {
        return new Response(JSON.stringify({ error: "Nom requis" }), { status: 400, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/workers`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ name, specialty: specialty || null, phone: phone || null, email: email || null, rbq_license: rbq_license || null, requires_rbq: !!requires_rbq }),
      });
      await logAudit("worker.create", "workers", null, { name, specialty });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "update_worker_verification") {
      const { worker_id, rbq_license, rbq_license_expiry, requires_rbq, insurance_expiry, verification_notes, insurance_base64, insurance_filename, insurance_content_type, mark_verified } = body;
      if (!worker_id) {
        return new Response(JSON.stringify({ error: "worker_id manquant" }), { status: 400, headers: corsHeaders });
      }

      let insuranceDocumentId: string | null = null;
      if (insurance_base64) {
        const path = `workers/${worker_id}/${Date.now()}-${insurance_filename || "assurance"}`;
        const bytes = Uint8Array.from(atob(insurance_base64), (c) => c.charCodeAt(0));
        const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/documents/${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${serviceRoleKey}`,
            apikey: serviceRoleKey ?? "",
            "Content-Type": insurance_content_type || "application/octet-stream",
          },
          body: bytes,
        });
        if (uploadRes.ok) {
          const docRes = await fetch(`${supabaseUrl}/rest/v1/documents`, {
            method: "POST",
            headers: { ...adminHeaders, Prefer: "return=representation" },
            body: JSON.stringify({ title: `Preuve d'assurance — travailleur ${worker_id}`, doc_type: "assurance_travailleur", file_url: path }),
          });
          const [doc] = await docRes.json();
          insuranceDocumentId = doc?.id ?? null;
        }
      }

      const patch: Record<string, unknown> = {};
      if (rbq_license !== undefined) patch.rbq_license = rbq_license || null;
      if (rbq_license_expiry !== undefined) patch.rbq_license_expiry = rbq_license_expiry || null;
      if (requires_rbq !== undefined) patch.requires_rbq = !!requires_rbq;
      if (insurance_expiry !== undefined) patch.insurance_expiry = insurance_expiry || null;
      if (verification_notes !== undefined) patch.verification_notes = verification_notes || null;
      if (insuranceDocumentId) patch.insurance_document_id = insuranceDocumentId;
      if (mark_verified) patch.verified_by_admin_at = new Date().toISOString();

      await fetch(`${supabaseUrl}/rest/v1/workers?id=eq.${worker_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify(patch),
      });
      await logAudit("worker.verification_updated", "workers", worker_id, patch);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "create_work_order") {
      const { service_request_id, unit_id, worker_id, description, worker_pay, appointment_at, entry_permission, billing_terms, due_by } = body;
      if (!unit_id || !worker_id || !description || !worker_pay) {
        return new Response(JSON.stringify({ error: "Champs manquants" }), { status: 400, headers: corsHeaders });
      }

      const verifRes = await fetch(`${supabaseUrl}/rest/v1/worker_verification_status?id=eq.${worker_id}&select=missing_rbq_license,rbq_expired,missing_insurance_doc,insurance_expired`, { headers: adminHeaders });
      const [verif] = await verifRes.json();
      const blockingReasons: string[] = [];
      if (verif?.missing_rbq_license) blockingReasons.push("licence RBQ manquante");
      if (verif?.rbq_expired) blockingReasons.push("licence RBQ expirée");
      if (verif?.missing_insurance_doc) blockingReasons.push("preuve d'assurance manquante");
      if (verif?.insurance_expired) blockingReasons.push("assurance expirée");
      if (blockingReasons.length) {
        return new Response(JSON.stringify({ error: `Impossible d'assigner ce travailleur — ${blockingReasons.join(", ")}. Complète sa vérification d'abord.` }), { status: 400, headers: corsHeaders });
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

      const verifRes = await fetch(`${supabaseUrl}/rest/v1/worker_verification_status?id=eq.${worker_id}&select=missing_rbq_license,rbq_expired,missing_insurance_doc,insurance_expired`, { headers: adminHeaders });
      const [verif] = await verifRes.json();
      const blockingReasons: string[] = [];
      if (verif?.missing_rbq_license) blockingReasons.push("licence RBQ manquante");
      if (verif?.rbq_expired) blockingReasons.push("licence RBQ expirée");
      if (verif?.missing_insurance_doc) blockingReasons.push("preuve d'assurance manquante");
      if (verif?.insurance_expired) blockingReasons.push("assurance expirée");
      if (blockingReasons.length) {
        return new Response(JSON.stringify({ error: `Impossible d'assigner ce travailleur — ${blockingReasons.join(", ")}. Complète sa vérification d'abord.` }), { status: 400, headers: corsHeaders });
      }

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
        `${supabaseUrl}/rest/v1/work_orders?id=eq.${work_order_id}&select=description,service_request_id,unit_id,tenant_confirmation_token,units(unit_number,building_id,buildings(address,owner_id)),service_requests(tenant_id,tenants(full_name,email))`,
        { headers: adminHeaders },
      );
      const [wo] = await woRes.json();
      if (!wo) {
        return new Response(JSON.stringify({ error: "Travail introuvable" }), { status: 404, headers: corsHeaders });
      }
      const buildingId = wo.units?.building_id;
      const ownerId = wo.units?.buildings?.owner_id;
      const tenant = wo.service_requests?.tenants;

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

      // Le dossier ne se ferme PAS tout de suite : on attend la
      // confirmation du locataire (voir handle-tenant-confirmation.ts et
      // le rappel/fermeture automatique dans flag_stuck_repair_cases()).
      // service_requests reste "in_progress" jusqu'à cette confirmation.
      const confirmPatchRes = await fetch(`${supabaseUrl}/rest/v1/work_orders?id=eq.${work_order_id}`, {
        method: "PATCH",
        headers: { ...adminHeaders, Prefer: "return=representation" },
        body: JSON.stringify({ status: "completed", tenant_confirmation_sent_at: new Date().toISOString() }),
      });
      const [updatedWorkOrder] = await confirmPatchRes.json().catch(() => [null]);
      const confirmationToken = updatedWorkOrder?.tenant_confirmation_token || wo.tenant_confirmation_token;

      if (tenant?.email && confirmationToken) {
        const address = wo.units?.buildings?.address;
        const confirmUrl = `https://portailgestion.ca/confirmer-reparation.html?wo=${work_order_id}&token=${confirmationToken}`;
        try {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: "Portail <onboarding@resend.dev>",
              to: [tenant.email],
              subject: `Ta réparation est complétée — confirme que tout est réglé`,
              text: `Bonjour ${tenant.full_name},\n\nLa réparation suivante a été complétée à ton logement (${address || ""}, unité ${wo.units?.unit_number || ""}) :\n${wo.description}\n\nPeux-tu confirmer que tout est réglé ? ${confirmUrl}\n\nSi rien ne se passe d'ici quelques jours, on considérera le dossier réglé automatiquement — mais si le problème persiste, dis-le-nous via ce lien.\n\nL'équipe Portail`,
            }),
          });
        } catch (e) {
          console.error("Failed to send tenant confirmation email", e);
        }
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

    if (action === "list_marketplace_listings") {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/units?marketplace_generated_at=not.is.null&status=in.(available,soon_available)&select=id,unit_type,rent,suggested_rent,marketplace_title,marketplace_description,marketplace_generated_at,marketplace_posted_at,buildings(address)&order=marketplace_generated_at.desc`,
        { headers: adminHeaders },
      );
      return new Response(JSON.stringify({ listings: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "mark_marketplace_posted") {
      const { unit_id, posted } = body;
      if (!unit_id) {
        return new Response(JSON.stringify({ error: "unit_id manquant" }), { status: 400, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/units?id=eq.${unit_id}`, {
        method: "PATCH", headers: adminHeaders,
        body: JSON.stringify({ marketplace_posted_at: posted === false ? null : new Date().toISOString() }),
      });
      await logAudit(posted === false ? "marketplace.unmarked_posted" : "marketplace.marked_posted", "units", unit_id, {});
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "list_visit_inquiries") {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/inquiries?type=eq.visite&status=eq.new&select=id,full_name,email,phone,message,unit_id,units(unit_number,buildings(address))&order=created_at.asc`,
        { headers: adminHeaders },
      );
      return new Response(JSON.stringify({ inquiries: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "list_visits") {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/visits?status=neq.cancelled&select=*,units(unit_number,buildings(address))&order=proposed_at.asc`,
        { headers: adminHeaders },
      );
      return new Response(JSON.stringify({ visits: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "propose_visit") {
      const { inquiry_id, unit_id, prospect_name, prospect_email, prospect_phone, proposed_at } = body;
      if (!unit_id || !prospect_name || !prospect_email || !proposed_at) {
        return new Response(JSON.stringify({ error: "Champs manquants" }), { status: 400, headers: corsHeaders });
      }

      const unitRes = await fetch(`${supabaseUrl}/rest/v1/units?id=eq.${unit_id}&select=unit_number,buildings(address)`, { headers: adminHeaders });
      const [unit] = await unitRes.json();

      const insertRes = await fetch(`${supabaseUrl}/rest/v1/visits`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "return=representation" },
        body: JSON.stringify({
          inquiry_id: inquiry_id || null, unit_id, prospect_name, prospect_email,
          prospect_phone: prospect_phone || null, proposed_at,
        }),
      });
      const [visit] = await insertRes.json();

      const confirmUrl = `https://portailgestion.ca/confirmer-visite.html?visit=${visit?.id}&token=${visit?.confirmation_token}`;
      const whenLabel = new Date(proposed_at).toLocaleString("fr-CA", { dateStyle: "full", timeStyle: "short" });
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Portail <onboarding@resend.dev>",
          to: [prospect_email],
          subject: `Proposition de visite — ${unit?.buildings?.address || ""}`,
          text: `Bonjour ${prospect_name},\n\nNous te proposons une visite du logement suivant :\n${unit?.buildings?.address || ""}, unité ${unit?.unit_number || ""}\nDate et heure proposées : ${whenLabel}\n\nMerci de confirmer, refuser ou proposer un autre moment via ce lien : ${confirmUrl}\n\nL'équipe Portail`,
        }),
      });

      if (inquiry_id) {
        await fetch(`${supabaseUrl}/rest/v1/inquiries?id=eq.${inquiry_id}`, {
          method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "contacted" }),
        });
      }
      await logAudit("visit.proposed", "visits", visit?.id ?? null, { unit_id, prospect_email, proposed_at });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "mark_visit_outcome") {
      const { visit_id, outcome, outcome_note } = body;
      if (!visit_id || !["completed", "no_show", "cancelled"].includes(outcome)) {
        return new Response(JSON.stringify({ error: "Paramètres invalides" }), { status: 400, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/visits?id=eq.${visit_id}`, {
        method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: outcome, outcome_note: outcome_note || null }),
      });
      await logAudit("visit.outcome_recorded", "visits", visit_id, { outcome });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "list_late_payments") {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/payments?status=eq.late&select=*,leases(monthly_rent,tenants(full_name,email),units(unit_number,buildings(address)))&order=due_date.asc`,
        { headers: adminHeaders },
      );
      return new Response(JSON.stringify({ payments: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "get_signed_url") {
      const { bucket, path } = body;
      const allowedBuckets = ["service-request-photos", "documents"];
      if (!bucket || !path || !allowedBuckets.includes(bucket)) {
        return new Response(JSON.stringify({ error: "Paramètres invalides" }), { status: 400, headers: corsHeaders });
      }
      const signRes = await fetch(`${supabaseUrl}/storage/v1/object/sign/${bucket}/${path}`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ expiresIn: 300 }),
      });
      if (!signRes.ok) {
        return new Response(JSON.stringify({ error: "Impossible de générer le lien" }), { status: 502, headers: corsHeaders });
      }
      const signed = await signRes.json();
      return new Response(JSON.stringify({ signed_url: `${supabaseUrl}/storage/v1${signed.signedURL}` }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "get_company_settings") {
      const res = await fetch(`${supabaseUrl}/rest/v1/company_settings?id=eq.true&select=*`, { headers: adminHeaders });
      const [settings] = await res.json().catch(() => [null]);
      return new Response(JSON.stringify({ settings }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "update_company_settings") {
      const { legal_name, address, gst_number, qst_number } = body;
      await fetch(`${supabaseUrl}/rest/v1/company_settings?id=eq.true`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({
          legal_name: legal_name || null, address: address || null,
          gst_number: gst_number || null, qst_number: qst_number || null,
          updated_at: new Date().toISOString(),
        }),
      });
      await logAudit("company_settings.updated", "company_settings", null, { gst_number: !!gst_number, qst_number: !!qst_number });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "list_invoices") {
      const res = await fetch(`${supabaseUrl}/rest/v1/invoices?select=*,owners(full_name)&order=period_end.desc`, { headers: adminHeaders });
      return new Response(JSON.stringify({ invoices: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "mark_invoice_paid") {
      const { invoice_id, paid } = body;
      if (!invoice_id) {
        return new Response(JSON.stringify({ error: "invoice_id manquant" }), { status: 400, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/invoices?id=eq.${invoice_id}`, {
        method: "PATCH", headers: adminHeaders,
        body: JSON.stringify({ status: paid === false ? "issued" : "paid" }),
      });
      await logAudit(paid === false ? "invoice.reopened" : "invoice.marked_paid", "invoices", invoice_id, {});
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
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
