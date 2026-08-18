const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Vérifie la signature du JWT (HS256, secret du projet Supabase) au lieu
// de se fier uniquement au réglage "Verify JWT" de la plateforme —
// défense en profondeur : cette fonction reste sûre même si ce réglage
// est mal configuré pour une fonction en particulier.
// Vérifie le JWT en le faisant valider par le service Auth de Supabase
// lui-même (GET /auth/v1/user) plutôt qu'en réimplémentant la
// cryptographie de vérification. La passerelle Edge Functions a un bug
// connu qui rejette à tort les JWT signés en ES256 quand verify_jwt=true
// est réglé au niveau plateforme (github.com/supabase/supabase/issues/42244)
// — d'où verify_jwt=false dans supabase/config.toml pour cette fonction :
// ce code est maintenant la seule vérification, et s'appuie sur l'API
// Auth de Supabase, qui elle gère ES256 correctement.
async function verifySupabaseJwt(jwt: string, supabaseUrl: string): Promise<{ sub: string; [key: string]: unknown } | null> {
  if (!jwt) return null;
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      },
    });
    if (!res.ok) return null;
    const user = await res.json().catch(() => null);
    if (!user?.id) return null;
    return { sub: user.id, ...user };
  } catch {
    return null;
  }
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
    const claims = await verifySupabaseJwt(jwt, Deno.env.get("SUPABASE_URL") ?? "");
    if (!claims) {
      return new Response(JSON.stringify({ error: "Jeton invalide ou expiré" }), { status: 401, headers: corsHeaders });
    }
    const userId = claims.sub as string;

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
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

    // Liste globale (tous propriétaires confondus) pour le sélecteur
    // d'immeuble de la lecture IA de factures — contrairement à
    // onboarding-api.list_buildings, pas besoin de connaître le
    // propriétaire d'avance : l'admin choisit souvent l'immeuble APRÈS
    // que l'IA ait tenté de le deviner sur la facture.
    if (action === "list_all_buildings") {
      const res = await fetch(`${supabaseUrl}/rest/v1/buildings?select=id,address,owners(full_name)&order=address.asc`, { headers: adminHeaders });
      return new Response(JSON.stringify({ buildings: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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

    // Portail Pro — approuve ou refuse le dossier d'un travailleur
    // auto-inscrit (voir handle-worker-registration.ts). Distinct de
    // update_worker_verification ci-dessus : ceci est la porte d'entrée
    // "peut-il recevoir des mandats du tout", pas le suivi continu de
    // l'expiration RBQ/assurance. Le moteur de dispatch n'admet que
    // verification_status = 'verified'.
    if (action === "verify_worker_pro") {
      const { worker_id, decision, rejection_reason } = body;
      if (!worker_id || !["verified", "rejected"].includes(decision)) {
        return new Response(JSON.stringify({ error: "worker_id et decision (verified|rejected) requis" }), { status: 400, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/workers?id=eq.${worker_id}`, {
        method: "PATCH", headers: adminHeaders,
        body: JSON.stringify({
          verification_status: decision,
          verified_at: new Date().toISOString(),
          verified_by: userId,
          rejection_reason: decision === "rejected" ? (rejection_reason || null) : null,
        }),
      });
      await logAudit(decision === "verified" ? "worker.pro_verified" : "worker.pro_rejected", "workers", worker_id, { rejection_reason: rejection_reason || null });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    // Désactive/réactive un travailleur — un travailleur désactivé n'est
    // plus jamais choisi par create_work_order, reassign_work_order, la
    // cascade automatique (process_worker_response_timeouts, decline) ni
    // le dispatch Portail Pro. Distinct de verify_worker_pro : un
    // travailleur peut être "vérifié" mais temporairement désactivé (ex:
    // en congé prolongé) sans perdre son dossier de vérification.
    if (action === "toggle_worker_active") {
      const { worker_id, active } = body;
      if (!worker_id) {
        return new Response(JSON.stringify({ error: "worker_id requis" }), { status: 400, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/workers?id=eq.${worker_id}`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ active: !!active }) });
      await logAudit(active ? "worker.reactivated" : "worker.deactivated", "workers", worker_id, {});
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "list_service_catalog") {
      const res = await fetch(`${supabaseUrl}/rest/v1/service_catalog?select=*&order=category.asc,label.asc`, { headers: adminHeaders });
      return new Response(JSON.stringify({ catalog: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "create_service_catalog_entry") {
      const { category, task_type, label, pricing_model, requires_rbq, fixed_owner_price, fixed_worker_pay, estimated_duration_minutes, urgent_eligible } = body;
      if (!category || !task_type || !label || !["forfait", "horaire", "diagnostic"].includes(pricing_model)) {
        return new Response(JSON.stringify({ error: "Champs manquants ou pricing_model invalide" }), { status: 400, headers: corsHeaders });
      }
      const res = await fetch(`${supabaseUrl}/rest/v1/service_catalog`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "return=representation" },
        body: JSON.stringify({
          category, task_type, label, pricing_model,
          requires_rbq: !!requires_rbq,
          fixed_owner_price: fixed_owner_price === "" || fixed_owner_price == null ? null : Number(fixed_owner_price),
          fixed_worker_pay: fixed_worker_pay === "" || fixed_worker_pay == null ? null : Number(fixed_worker_pay),
          estimated_duration_minutes: estimated_duration_minutes === "" || estimated_duration_minutes == null ? null : Math.round(Number(estimated_duration_minutes)),
          urgent_eligible: urgent_eligible !== false,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return new Response(JSON.stringify({ error: err?.message || "task_type déjà existant ou champs invalides" }), { status: 400, headers: corsHeaders });
      }
      const [entry] = await res.json();
      await logAudit("service_catalog.create", "service_catalog", entry?.id ?? null, { task_type, label });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "toggle_service_catalog_active") {
      const { catalog_id, active } = body;
      if (!catalog_id) {
        return new Response(JSON.stringify({ error: "catalog_id requis" }), { status: 400, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/service_catalog?id=eq.${catalog_id}`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ active: !!active }) });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "create_work_order") {
      const { service_request_id, unit_id, worker_id, description, worker_pay, appointment_at, entry_permission, billing_terms, due_by } = body;
      if (!unit_id || !worker_id || !description || !worker_pay) {
        return new Response(JSON.stringify({ error: "Champs manquants" }), { status: 400, headers: corsHeaders });
      }

      const verifRes = await fetch(`${supabaseUrl}/rest/v1/worker_verification_status?id=eq.${worker_id}&select=missing_rbq_license,rbq_expired,missing_insurance_doc,insurance_expired,active`, { headers: adminHeaders });
      const [verif] = await verifRes.json();
      const blockingReasons: string[] = [];
      if (verif?.missing_rbq_license) blockingReasons.push("licence RBQ manquante");
      if (verif?.rbq_expired) blockingReasons.push("licence RBQ expirée");
      if (verif?.missing_insurance_doc) blockingReasons.push("preuve d'assurance manquante");
      if (verif?.insurance_expired) blockingReasons.push("assurance expirée");
      if (verif?.active === false) blockingReasons.push("travailleur désactivé");
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

    // Portail Pro — au lieu de choisir un travailleur soi-même (comme
    // create_work_order ci-dessus), on laisse le moteur de dispatch
    // (dispatch-work-order.ts) trouver et solliciter les travailleurs
    // admissibles par paliers de score. Aucun worker_id ici : le work
    // order reste "open" jusqu'à ce qu'un travailleur accepte une offre.
    if (action === "dispatch_work_order_auto") {
      const { service_request_id, unit_id, description, service_catalog_id, worker_pay } = body;
      if (!unit_id || !description) {
        return new Response(JSON.stringify({ error: "Champs manquants" }), { status: 400, headers: corsHeaders });
      }

      let resolvedPay = worker_pay != null ? Number(worker_pay) : null;
      if (service_catalog_id && resolvedPay === null) {
        const catRes = await fetch(`${supabaseUrl}/rest/v1/service_catalog?id=eq.${service_catalog_id}&select=fixed_worker_pay`, { headers: adminHeaders });
        const [cat] = await catRes.json().catch(() => [null]);
        resolvedPay = cat?.fixed_worker_pay ?? null;
      }
      const coordinationFee = resolvedPay !== null ? Math.round(resolvedPay * 0.10 * 100) / 100 : null;
      const estimatedCost = resolvedPay !== null && coordinationFee !== null ? Math.round((resolvedPay + coordinationFee) * 100) / 100 : null;

      const woInsertRes = await fetch(`${supabaseUrl}/rest/v1/work_orders`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "return=representation" },
        body: JSON.stringify({
          service_request_id: service_request_id || null,
          unit_id, description,
          worker_pay: resolvedPay,
          coordination_fee: coordinationFee,
          estimated_cost: estimatedCost,
          service_catalog_id: service_catalog_id || null,
          dispatch_mode: "auto",
          status: "open",
        }),
      });
      const [newWorkOrder] = await woInsertRes.json();
      if (!newWorkOrder?.id) {
        return new Response(JSON.stringify({ error: "Impossible de créer le work order" }), { status: 500, headers: corsHeaders });
      }
      if (service_request_id) {
        await fetch(`${supabaseUrl}/rest/v1/service_requests?id=eq.${service_request_id}`, {
          method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "in_progress", pending_reassessment: false, reassessment_due: null }),
        });
      }

      const dispatchRes = await fetch(`${supabaseUrl}/functions/v1/dispatch-work-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: anonKey, Authorization: `Bearer ${anonKey}` },
        body: JSON.stringify({ action: "dispatch", work_order_id: newWorkOrder.id }),
      });
      const dispatchData = await dispatchRes.json().catch(() => ({}));

      await logAudit("work_order.auto_dispatch_started", "work_orders", newWorkOrder.id, { dispatch_result: dispatchData });
      return new Response(JSON.stringify({ ok: true, work_order_id: newWorkOrder.id, dispatch: dispatchData }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "reassign_work_order") {
      const { work_order_id, worker_id } = body;

      const verifRes = await fetch(`${supabaseUrl}/rest/v1/worker_verification_status?id=eq.${worker_id}&select=missing_rbq_license,rbq_expired,missing_insurance_doc,insurance_expired,active`, { headers: adminHeaders });
      const [verif] = await verifRes.json();
      const blockingReasons: string[] = [];
      if (verif?.missing_rbq_license) blockingReasons.push("licence RBQ manquante");
      if (verif?.rbq_expired) blockingReasons.push("licence RBQ expirée");
      if (verif?.missing_insurance_doc) blockingReasons.push("preuve d'assurance manquante");
      if (verif?.insurance_expired) blockingReasons.push("assurance expirée");
      if (verif?.active === false) blockingReasons.push("travailleur désactivé");
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
              from: "Portail <onboarding@mail.portailgestion.ca>",
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
          from: "Portail <onboarding@mail.portailgestion.ca>",
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

    if (action === "list_pad_authorizations") {
      const res = await fetch(`${supabaseUrl}/rest/v1/pad_authorizations?select=*,owners(full_name)&order=created_at.desc`, { headers: adminHeaders });
      return new Response(JSON.stringify({ authorizations: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "update_pad_authorization") {
      const { owner_id, status, consent_method, processor, processor_reference, notes } = body;
      if (!owner_id || !status) {
        return new Response(JSON.stringify({ error: "owner_id et status requis" }), { status: 400, headers: corsHeaders });
      }
      const patch: Record<string, unknown> = { status, consent_method: consent_method || null, processor: processor || null, processor_reference: processor_reference || null, notes: notes || null };
      if (status === "active") patch.consented_at = new Date().toISOString();
      if (status === "revoked") patch.revoked_at = new Date().toISOString();
      await fetch(`${supabaseUrl}/rest/v1/pad_authorizations?on_conflict=owner_id`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ owner_id, ...patch }),
      });
      await logAudit("pad_authorization.updated", "pad_authorizations", null, { owner_id, status });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    // Distinct de pad_authorizations (frais de gestion Portail→propriétaire) :
    // ceci concerne le PAD du loyer, locataire→propriétaire, rattaché au
    // bail. Voir supabase/migrations/20260818073900_pad_locataire_squelette.sql —
    // squelette en attente du branchement du processeur par l'équipe TWIM.
    if (action === "list_active_leases") {
      const res = await fetch(`${supabaseUrl}/rest/v1/leases?status=eq.active&select=id,tenant_id,monthly_rent,tenants(full_name),units(unit_number,buildings(address))&order=created_at.desc`, { headers: adminHeaders });
      return new Response(JSON.stringify({ leases: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "list_tenant_pad_authorizations") {
      const res = await fetch(`${supabaseUrl}/rest/v1/tenant_pad_authorizations?select=*,leases(monthly_rent,units(unit_number,buildings(address))),tenants(full_name)&order=created_at.desc`, { headers: adminHeaders });
      return new Response(JSON.stringify({ authorizations: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "update_tenant_pad_authorization") {
      const { lease_id, tenant_id, status, consent_method, processor, processor_customer_id, processor_mandate_id, notes } = body;
      if (!lease_id || !tenant_id || !status) {
        return new Response(JSON.stringify({ error: "lease_id, tenant_id et status requis" }), { status: 400, headers: corsHeaders });
      }
      const patch: Record<string, unknown> = {
        status, consent_method: consent_method || null, processor: processor || null,
        processor_customer_id: processor_customer_id || null, processor_mandate_id: processor_mandate_id || null, notes: notes || null,
      };
      if (status === "active") patch.consented_at = new Date().toISOString();
      if (status === "revoked") patch.revoked_at = new Date().toISOString();
      await fetch(`${supabaseUrl}/rest/v1/tenant_pad_authorizations?on_conflict=lease_id`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ lease_id, tenant_id, ...patch }),
      });
      await logAudit("tenant_pad_authorization.updated", "tenant_pad_authorizations", null, { lease_id, status });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "mark_invoice_collected") {
      const { invoice_id } = body;
      if (!invoice_id) {
        return new Response(JSON.stringify({ error: "invoice_id manquant" }), { status: 400, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/invoices?id=eq.${invoice_id}`, {
        method: "PATCH", headers: adminHeaders,
        body: JSON.stringify({ collection_status: "collected", collected_at: new Date().toISOString(), collection_error: null, status: "paid" }),
      });
      await logAudit("invoice.marked_collected", "invoices", invoice_id, {});
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "mark_invoice_failed") {
      const { invoice_id, error_message } = body;
      if (!invoice_id) {
        return new Response(JSON.stringify({ error: "invoice_id manquant" }), { status: 400, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/invoices?id=eq.${invoice_id}`, {
        method: "PATCH", headers: adminHeaders,
        body: JSON.stringify({ collection_status: "failed", collection_error: error_message || "Échec du prélèvement" }),
      });
      await logAudit("invoice.marked_failed", "invoices", invoice_id, { error_message });
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

    // ---- Automations / Studio (fondation) ----
    // Catalogue fermé de déclencheurs (pas un bus d'événements générique) :
    // les mêmes signaux déjà calculés ailleurs (retard de loyer, échéance
    // de bail). Le message envoyé est TOUJOURS rédigé par l'admin ici,
    // jamais par l'IA — voir execute_automation_rules() dans schema.sql.
    if (action === "list_automation_rules") {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/automation_rules?select=*&order=created_at.desc`,
        { headers: adminHeaders },
      );
      const rules = await res.json();
      const runsRes = await fetch(
        `${supabaseUrl}/rest/v1/automation_rule_runs?select=rule_id,result&order=fired_at.desc&limit=1000`,
        { headers: adminHeaders },
      );
      const runs = await runsRes.json();
      const runCounts: Record<string, number> = {};
      for (const r of Array.isArray(runs) ? runs : []) {
        runCounts[r.rule_id] = (runCounts[r.rule_id] || 0) + 1;
      }
      return new Response(JSON.stringify({
        rules: (Array.isArray(rules) ? rules : []).map((r: any) => ({ ...r, run_count: runCounts[r.id] || 0 })),
      }), { status: 200, headers: corsHeaders });
    }

    if (action === "create_automation_rule") {
      const { name, trigger_type, threshold_days, action_type, action_message } = body;
      if (!name || !trigger_type || !action_type) {
        return new Response(JSON.stringify({ error: "name, trigger_type et action_type requis" }), { status: 400, headers: corsHeaders });
      }
      if (!["retard_loyer", "bail_echeance"].includes(trigger_type)) {
        return new Response(JSON.stringify({ error: "trigger_type invalide" }), { status: 400, headers: corsHeaders });
      }
      if (!["notifier_admin", "envoyer_rappel_email"].includes(action_type)) {
        return new Response(JSON.stringify({ error: "action_type invalide" }), { status: 400, headers: corsHeaders });
      }
      if (action_type === "envoyer_rappel_email" && !action_message) {
        return new Response(JSON.stringify({ error: "action_message requis pour envoyer_rappel_email — l'IA ne rédige jamais ce message automatiquement" }), { status: 400, headers: corsHeaders });
      }
      const insertRes = await fetch(`${supabaseUrl}/rest/v1/automation_rules`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "return=representation" },
        body: JSON.stringify({
          name, trigger_type,
          threshold_days: Number(threshold_days) || 0,
          action_type, action_message: action_message || null,
          created_by: userId,
        }),
      });
      const [created] = await insertRes.json();
      await logAudit("automation_rule.created", "automation_rules", created?.id || null, { name, trigger_type, action_type });
      return new Response(JSON.stringify({ ok: true, rule: created }), { status: 200, headers: corsHeaders });
    }

    if (action === "toggle_automation_rule") {
      const { rule_id, active } = body;
      if (!rule_id) {
        return new Response(JSON.stringify({ error: "rule_id manquant" }), { status: 400, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/automation_rules?id=eq.${rule_id}`, {
        method: "PATCH", headers: adminHeaders,
        body: JSON.stringify({ active: !!active }),
      });
      await logAudit(active ? "automation_rule.activated" : "automation_rule.deactivated", "automation_rules", rule_id, { active: !!active });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "delete_automation_rule") {
      const { rule_id } = body;
      if (!rule_id) {
        return new Response(JSON.stringify({ error: "rule_id manquant" }), { status: 400, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/automation_rules?id=eq.${rule_id}`, { method: "DELETE", headers: adminHeaders });
      await logAudit("automation_rule.deleted", "automation_rules", rule_id, {});
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    // Monitoring minimum — mêmes vérifications déterministes que
    // l'endpoint public health-check.ts, mais consommé ici par le
    // tableau de bord admin (authentifié, pas besoin d'un aller-retour
    // public supplémentaire).
    if (action === "get_system_health") {
      const res = await fetch(`${supabaseUrl}/rest/v1/rpc/check_system_health`, { method: "POST", headers: adminHeaders, body: "{}" });
      const health = await res.json().catch(() => ({ healthy: false, issues: [] }));
      return new Response(JSON.stringify({ health }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
