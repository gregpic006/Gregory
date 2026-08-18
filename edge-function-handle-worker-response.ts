// Fonction PUBLIQUE (pas de JWT) : le travailleur clique un lien dans
// son courriel, protégé uniquement par le token à usage unique
// (worker_response_token). Actions : get, accept, decline,
// propose_time, request_info. "decline" cascade immédiatement au
// prochain travailleur disponible de la même spécialité ; si aucun
// n'est disponible, un admin est alerté sur-le-champ.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const body = await req.json().catch(() => ({}));
    const { work_order_id, token, action, message } = body;
    if (!work_order_id || !token || !action) {
      return new Response(JSON.stringify({ error: "Paramètres manquants" }), { status: 400, headers: corsHeaders });
    }

    const woRes = await fetch(
      `${supabaseUrl}/rest/v1/work_orders?id=eq.${work_order_id}&select=*,workers(name,email,specialty),units(unit_number,buildings(address))`,
      { headers: adminHeaders },
    );
    const [wo] = await woRes.json();
    if (!wo || wo.worker_response_token !== token) {
      return new Response(JSON.stringify({ error: "Lien invalide ou expiré" }), { status: 403, headers: corsHeaders });
    }

    const unit = wo.units;
    const address = unit?.buildings?.address;

    const logAudit = (action2: string, details: Record<string, unknown>) =>
      fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ actor_type: "system", action: action2, entity_type: "work_orders", entity_id: work_order_id, details }),
      });

    const notifyAdmins = async (subject: string, text: string) => {
      const adminsRes = await fetch(`${supabaseUrl}/rest/v1/users?is_admin=eq.true&select=email`, { headers: adminHeaders });
      const admins = await adminsRes.json().catch(() => []);
      const adminEmails = Array.isArray(admins) ? admins.map((a: any) => a.email).filter(Boolean) : [];
      if (adminEmails.length && resendKey) {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: "Portail <onboarding@mail.portailgestion.ca>", to: adminEmails, subject, text }),
        });
      }
    };

    if (action === "get") {
      return new Response(JSON.stringify({
        description: wo.description,
        address,
        unit_number: unit?.unit_number,
        worker_pay: wo.worker_pay,
        appointment_at: wo.appointment_at,
        entry_permission: wo.entry_permission,
        due_by: wo.due_by,
        billing_terms: wo.billing_terms,
        worker_response: wo.worker_response,
        worker_name: wo.workers?.name,
        status: wo.status,
        worker_reported_done_at: wo.worker_reported_done_at,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "submit_completion") {
      if (wo.worker_response !== "accepted") {
        return new Response(JSON.stringify({ error: "Ce travail n'a pas encore été accepté." }), { status: 409, headers: corsHeaders });
      }
      if (wo.worker_reported_done_at) {
        return new Response(JSON.stringify({ error: "La fin des travaux a déjà été signalée pour ce travail." }), { status: 409, headers: corsHeaders });
      }

      const { before_photos, after_photos } = body;
      let skippedPhotoCount = 0;
      const uploadPhotos = async (photos: Array<{ base64: string; filename?: string; content_type?: string }> | undefined, subfolder: string) => {
        const paths: string[] = [];
        for (const p of (Array.isArray(photos) ? photos : []).slice(0, 5)) {
          if (!p?.base64) continue;
          const path = `work-orders/${work_order_id}/${subfolder}/${Date.now()}-${(p.filename || "photo.jpg").replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
          const bytes = Uint8Array.from(atob(p.base64), (c) => c.charCodeAt(0));
          const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/service-request-photos/${path}`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${serviceRoleKey}`,
              apikey: serviceRoleKey ?? "",
              "Content-Type": p.content_type || "application/octet-stream",
            },
            body: bytes,
          });
          // Une photo qui échoue à téléverser était jusqu'ici abandonnée en
          // silence — le travailleur n'avait aucune façon de savoir qu'une
          // partie de ses photos n'avait pas été envoyée. On compte les
          // échecs pour le signaler dans la réponse (voir skipped_photos).
          if (uploadRes.ok) paths.push(path);
          else skippedPhotoCount++;
        }
        return paths;
      };

      const beforeUrls = await uploadPhotos(before_photos, "avant");
      const afterUrls = await uploadPhotos(after_photos, "apres");
      if (!beforeUrls.length && !afterUrls.length) {
        return new Response(JSON.stringify({ error: "Au moins une photo est requise." }), { status: 400, headers: corsHeaders });
      }

      await fetch(`${supabaseUrl}/rest/v1/work_orders?id=eq.${work_order_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({
          photo_before_urls: beforeUrls,
          photo_after_urls: afterUrls,
          worker_reported_done_at: new Date().toISOString(),
          worker_completion_note: message || null,
        }),
      });

      await logAudit("work_order.worker_reported_done", { photos_before: beforeUrls.length, photos_after: afterUrls.length, note: message || null });
      await notifyAdmins(
        `Travail terminé (signalé par le travailleur) — ${address || ""}`,
        `${wo.workers?.name || "Le travailleur"} a signalé avoir terminé : ${wo.description}\n${message ? "Note : " + message + "\n" : ""}Photos avant : ${beforeUrls.length}, après : ${afterUrls.length}\n\nEntre le coût final dans le portail admin pour clore le dossier et aviser le locataire.`,
      );

      return new Response(JSON.stringify({ ok: true, skipped_photos: skippedPhotoCount || undefined }), { status: 200, headers: corsHeaders });
    }

    if (wo.worker_response !== "pending") {
      return new Response(JSON.stringify({ error: "Une réponse a déjà été enregistrée pour ce travail." }), { status: 409, headers: corsHeaders });
    }

    if (action === "accept") {
      await fetch(`${supabaseUrl}/rest/v1/work_orders?id=eq.${work_order_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        // Statut "in_progress" dès l'acceptation : le cycle de réparation
        // (voir flag_stuck_repair_cases) peut ainsi distinguer "assigné,
        // en attente de réponse" de "confirmé, travail en cours".
        body: JSON.stringify({ worker_response: "accepted", worker_response_at: new Date().toISOString(), status: "in_progress" }),
      });
      await logAudit("work_order.worker_accepted", { worker: wo.workers?.name });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "decline") {
      const declinedIds: string[] = Array.isArray(wo.declined_worker_ids) ? [...wo.declined_worker_ids, wo.worker_id] : [wo.worker_id];
      const specialty = wo.workers?.specialty;
      const specialtyFilter = specialty ? `&specialty=eq.${encodeURIComponent(specialty)}` : "";

      // CORRECTIF SÉCURITÉ/FONCTIONNEL : interroge worker_verification_status
      // (pas "workers" directement) et filtre par conformité RBQ/assurance
      // et statut actif — sans ça, cette cascade pouvait réassigner à un
      // travailleur avec licence expirée, assurance manquante, ou
      // désactivé, contournant les mêmes contrôles déjà appliqués à
      // l'assignation manuelle (create_work_order/reassign_work_order).
      // Récupère aussi plusieurs candidats (au lieu de limit=1) pour tirer
      // au sort — l'ancienne version prenait toujours le même premier
      // résultat, sans répartition entre travailleurs disponibles.
      const candidatesRes = await fetch(
        `${supabaseUrl}/rest/v1/worker_verification_status?id=not.in.(${declinedIds.join(",")})${specialtyFilter}&active=eq.true&missing_rbq_license=eq.false&rbq_expired=eq.false&missing_insurance_doc=eq.false&insurance_expired=eq.false&select=id&limit=20`,
        { headers: adminHeaders },
      );
      const candidates = await candidatesRes.json().catch(() => []);
      const nextWorker = Array.isArray(candidates) && candidates.length
        ? candidates[Math.floor(Math.random() * candidates.length)]
        : null;

      if (nextWorker) {
        await fetch(`${supabaseUrl}/rest/v1/work_orders?id=eq.${work_order_id}`, {
          method: "PATCH",
          headers: adminHeaders,
          body: JSON.stringify({
            declined_worker_ids: declinedIds,
            worker_id: nextWorker.id,
            worker_notified: false,
            worker_response_note: message || null,
          }),
        });
      } else {
        await fetch(`${supabaseUrl}/rest/v1/work_orders?id=eq.${work_order_id}`, {
          method: "PATCH",
          headers: adminHeaders,
          body: JSON.stringify({
            declined_worker_ids: declinedIds,
            worker_response: "declined",
            worker_response_at: new Date().toISOString(),
            response_escalated: true,
            worker_response_note: message || null,
          }),
        });
        await notifyAdmins(
          `Aucun travailleur disponible — ${address || ""}, unité ${unit?.unit_number || ""}`,
          `${wo.workers?.name || "Le travailleur"} a refusé ce travail (${wo.description}) et aucun autre travailleur de la spécialité "${specialty || "non spécifiée"}" n'est disponible. Assignation manuelle requise dans le portail admin.`,
        );
      }

      await logAudit("work_order.worker_declined", { declined_by: wo.workers?.name, reassigned: !!nextWorker });
      return new Response(JSON.stringify({ ok: true, reassigned: !!nextWorker }), { status: 200, headers: corsHeaders });
    }

    if (action === "propose_time" || action === "request_info") {
      const responseValue = action === "propose_time" ? "proposed_other_time" : "info_requested";
      await fetch(`${supabaseUrl}/rest/v1/work_orders?id=eq.${work_order_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ worker_response: responseValue, worker_response_at: new Date().toISOString(), worker_response_note: message || null }),
      });

      await notifyAdmins(
        action === "propose_time"
          ? `${wo.workers?.name || "Un travailleur"} propose une autre heure — ${address || ""}`
          : `${wo.workers?.name || "Un travailleur"} demande des infos — ${address || ""}`,
        `Travail : ${wo.description}\nMessage du travailleur : ${message || "(aucun message)"}\n\nUne réponse manuelle est requise — ce travail n'avancera pas automatiquement tant qu'un admin n'aura pas tranché.`,
      );

      await logAudit(`work_order.worker_${responseValue}`, { message: message || null });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
