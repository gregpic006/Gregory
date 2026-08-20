// Moteur de dispatch Portail Pro — trouve automatiquement les travailleurs
// admissibles à un work_order et leur diffuse le mandat par paliers de
// score (au lieu qu'un admin cherche manuellement au téléphone).
//
// action "dispatch"   : point d'entrée — calcule les travailleurs éligibles,
//                        le Portail Score de chacun, groupe en paliers, et
//                        envoie le palier 1 (ou TOUS les travailleurs
//                        "urgence" en une seule diffusion si le cas est
//                        urgent — pas de paliers pour une urgence réelle).
// action "advance"    : appelée par pg_cron — fait expirer les offres du
//                        palier courant si le délai est dépassé sans
//                        acceptation, active le palier suivant, ou
//                        escalade à l'admin si plus aucun palier.
//
// Convention identique à find-prospects-ai.ts/flinks-api.ts "sync_all" :
// ces deux actions sont des actions système (appelées par un trigger DB ou
// par pg_cron avec la clé publique), aucune vérification JWT/is_admin ici.
// Liste blanche d'origines : évite d'exposer les fonctions à un
// site tiers qui embarquerait un appel authentifié depuis le
// navigateur d'un usager (CSRF via fetch). Les appels serveur à
// serveur (cron, webhooks, autre fonction edge) n'envoient pas
// d'en-tête Origin et ne sont donc pas affectés par ce contrôle.
const ALLOWED_ORIGINS = ["https://portailgestion.ca", "https://www.portailgestion.ca"];
function corsHeadersFor(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

const SITE_BASE_URL = "https://portailgestion.ca";
const NORMAL_TIER_TIMEOUT_MINUTES = 20;
const URGENT_TIMEOUT_MINUTES = 8;
const WORKERS_PER_TIER = 3;

// Instructions de sécurité déterministes par code de règle (voir
// SAFETY_RULES dans handle-service-request.ts) — jamais générées
// librement par l'IA pour un cas urgent, exactement comme le reste des
// règles de sécurité du produit.
const SAFETY_INSTRUCTIONS: Record<string, string> = {
  gaz: "Sors du logement immédiatement, n'actionne aucun interrupteur électrique, et appelle Énergir/ton fournisseur de gaz ainsi que le 911 si tu sens une odeur forte.",
  feu: "Sors du logement immédiatement et appelle le 911. Ne retourne pas à l'intérieur.",
  fuite_eau: "Si tu sais où se trouve la valve d'arrêt d'eau, ferme-la. Éponge ce que tu peux et éloigne tout appareil électrique de la zone mouillée.",
  chauffage: "Habille-toi chaudement, évite les chaufferettes d'appoint non surveillées, et signale-nous si la température devient dangereuse pour des enfants, personnes âgées ou animaux.",
  electrique: "Ne touche pas à la source du problème (prise, fil, interrupteur) et coupe le disjoncteur concerné si tu peux le faire en toute sécurité.",
  enferme: "Reste calme, appelle le 911 si la situation est dangereuse, sinon reste joignable — quelqu'un de Portail te contacte immédiatement.",
  egout: "Évite tout contact avec l'eau contaminée, ferme la porte de la pièce touchée si possible, et aère si tu le peux sans aggraver la situation.",
};
const DEFAULT_SAFETY_INSTRUCTIONS = "Reste en sécurité et évite d'intervenir toi-même sur le problème — un travailleur va te contacter très prochainement.";

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req.headers.get("origin"));
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
    const action = body.action;

    const logAudit = (action2: string, entityId: string | null, details: Record<string, unknown>) =>
      fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ actor_type: "system", action: action2, entity_type: "work_orders", entity_id: entityId, details }),
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
        }).catch(() => null);
      }
    };

    // Envoie l'offre par courriel — le travailleur se connecte à son
    // portail pour voir le détail et répondre (pas de lien à usage
    // unique : ces travailleurs ont un vrai compte persistant).
    const sendOfferEmails = async (workers: any[], workOrder: any, address: string, unitNumber: string) => {
      if (!resendKey) return;
      for (const w of workers) {
        if (!w.email) continue;
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "Portail <onboarding@mail.portailgestion.ca>",
            to: [w.email],
            subject: workOrder.is_urgent
              ? `URGENT — nouveau mandat disponible — ${address}, unité ${unitNumber}`
              : `Nouveau mandat disponible — ${address}, unité ${unitNumber}`,
            text: `Un mandat correspondant à ton profil est disponible.\n\nDescription : ${workOrder.description}\nAdresse : ${address}, unité ${unitNumber}\nRémunération offerte : ${workOrder.worker_pay != null ? workOrder.worker_pay + " $" : "à discuter (diagnostic requis)"}\n${workOrder.is_urgent ? "\nCeci est un mandat URGENT — premier arrivé, premier servi.\n" : ""}\nConnecte-toi à ton portail pour l'accepter avant qu'un autre travailleur ne le prenne :\n${SITE_BASE_URL}/portail-travailleur.html\n\nL'équipe Portail`,
          }),
        }).catch(() => null);
      }
    };

    // ---- Calcule les travailleurs éligibles + leur Portail Score pour un work_order ----
    const computeEligibleWorkers = async (workOrder: any, category: string | null, zone: string | null, requiresRbq: boolean) => {
      const res = await fetch(`${supabaseUrl}/rest/v1/worker_verification_status?verification_status=eq.verified&active=eq.true&select=*`, { headers: adminHeaders });
      const all = await res.json().catch(() => []);
      if (!Array.isArray(all)) return [];

      const alreadyOfferedRes = await fetch(`${supabaseUrl}/rest/v1/job_offers?work_order_id=eq.${workOrder.id}&select=worker_id`, { headers: adminHeaders });
      const alreadyOffered = new Set((await alreadyOfferedRes.json().catch(() => [])).map((o: any) => o.worker_id));

      const eligible = all.filter((w: any) => {
        if (alreadyOffered.has(w.id)) return false;
        if (w.availability_status === "indisponible") return false;
        if (workOrder.is_urgent && !w.handles_urgent) return false;
        if (category && Array.isArray(w.specialties) && w.specialties.length && !w.specialties.includes(category)) return false;
        if (zone && Array.isArray(w.zones) && w.zones.length && !w.zones.includes(zone)) return false;
        if (w.missing_insurance_doc || w.insurance_expired) return false;
        if (requiresRbq && (w.missing_rbq_license || w.rbq_expired)) return false;
        return true;
      });

      const availScore: Record<string, number> = { maintenant: 1, aujourdhui: 0.7, semaine: 0.4 };
      const rates = eligible.map((w: any) => w.hourly_rate).filter((r: any) => typeof r === "number");
      const minRate = rates.length ? Math.min(...rates) : null;
      const maxRate = rates.length ? Math.max(...rates) : null;

      const scored = eligible.map((w: any) => {
        const acceptanceRate = w.jobs_offered_count > 0 ? w.jobs_accepted_count / w.jobs_offered_count : 0.5;
        const reliability = w.jobs_accepted_count > 0 ? 1 - w.jobs_cancelled_count / w.jobs_accepted_count : 1;
        const ratingScore = typeof w.rating === "number" ? w.rating / 5 : 0.6;
        let priceScore = 0.5;
        if (typeof w.hourly_rate === "number" && minRate !== null && maxRate !== null && maxRate > minRate) {
          priceScore = 1 - (w.hourly_rate - minRate) / (maxRate - minRate);
        }
        const score =
          (availScore[w.availability_status] ?? 0.4) * 0.25 +
          ratingScore * 0.2 +
          acceptanceRate * 0.15 +
          reliability * 0.15 +
          priceScore * 0.15 +
          0.1; // base — l'admissibilité (métier/zone/RBQ/assurance) a déjà filtré le reste
        return { worker: w, score: Math.round(score * 1000) / 10 };
      });

      scored.sort((a, b) => b.score - a.score);
      return scored;
    };

    const loadWorkOrderContext = async (workOrderId: string) => {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/work_orders?id=eq.${workOrderId}&select=*,units(unit_number,buildings(address,zone)),service_requests(ai_category,ai_urgency,safety_override,safety_flags)`,
        { headers: adminHeaders },
      );
      const [wo] = await res.json().catch(() => [null]);
      return wo;
    };

    if (action === "dispatch") {
      const { work_order_id } = body;
      if (!work_order_id) {
        return new Response(JSON.stringify({ error: "work_order_id requis" }), { status: 400, headers: corsHeaders });
      }
      const wo = await loadWorkOrderContext(work_order_id);
      if (!wo) {
        return new Response(JSON.stringify({ error: "Work order introuvable" }), { status: 404, headers: corsHeaders });
      }
      if (wo.worker_id) {
        return new Response(JSON.stringify({ ok: true, note: "Déjà assigné" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const sr = wo.service_requests;
      const isUrgent = !!(sr?.ai_urgency === "urgence" || sr?.safety_override);
      const zone = wo.units?.buildings?.zone ?? null;
      const address = wo.units?.buildings?.address ?? "";
      const unitNumber = wo.units?.unit_number ?? "";

      let catalogEntry: any = null;
      if (wo.service_catalog_id) {
        const catRes = await fetch(`${supabaseUrl}/rest/v1/service_catalog?id=eq.${wo.service_catalog_id}&select=category,requires_rbq`, { headers: adminHeaders });
        [catalogEntry] = await catRes.json().catch(() => [null]);
      }
      const category = catalogEntry?.category ?? sr?.ai_category?.toLowerCase() ?? null;
      const requiresRbq = !!catalogEntry?.requires_rbq;

      await fetch(`${supabaseUrl}/rest/v1/work_orders?id=eq.${work_order_id}`, {
        method: "PATCH", headers: adminHeaders,
        body: JSON.stringify({ is_urgent: isUrgent, dispatch_mode: "auto", dispatch_started_at: new Date().toISOString() }),
      });

      // Cas urgent : instructions de sécurité déterministes au locataire +
      // alerte admin immédiate, humain toujours dans la boucle — tout de
      // suite, pas seulement si personne n'accepte.
      if (isUrgent) {
        const flags: string[] = Array.isArray(sr?.safety_flags) ? sr.safety_flags : [];
        const instructions = flags.length
          ? flags.map((f) => SAFETY_INSTRUCTIONS[f] ?? DEFAULT_SAFETY_INSTRUCTIONS).join(" ")
          : DEFAULT_SAFETY_INSTRUCTIONS;
        await fetch(`${supabaseUrl}/rest/v1/work_orders?id=eq.${work_order_id}`, {
          method: "PATCH", headers: adminHeaders, body: JSON.stringify({ safety_instructions: instructions }),
        });
        await notifyAdmins(
          `URGENCE — dispatch en cours — ${address}, unité ${unitNumber}`,
          `Un mandat urgent est en cours de diffusion à tous les travailleurs "urgence" disponibles.\n\nDescription : ${wo.description}\n\nUn humain doit rester attentif à ce dossier jusqu'à confirmation d'acceptation.`,
        );
      }

      const scored = await computeEligibleWorkers(wo, category, zone, requiresRbq);
      if (!scored.length) {
        await fetch(`${supabaseUrl}/rest/v1/work_orders?id=eq.${work_order_id}`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ dispatch_escalated: true }) });
        await notifyAdmins(
          `Aucun travailleur admissible — ${address}, unité ${unitNumber}`,
          `Aucun travailleur vérifié n'est actuellement admissible pour ce mandat (métier/zone/RBQ/assurance/disponibilité). Assignation manuelle requise.\n\nDescription : ${wo.description}`,
        );
        await logAudit("work_order.dispatch_no_eligible_workers", work_order_id, { category, zone, is_urgent: isUrgent });
        return new Response(JSON.stringify({ ok: true, dispatched: 0, escalated: true }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Urgence : un seul palier, tout le monde en même temps.
      // Cas normal : paliers de WORKERS_PER_TIER, triés par score.
      const offers = isUrgent
        ? scored.map((s) => ({ ...s, tier: 1 }))
        : scored.map((s, i) => ({ ...s, tier: Math.floor(i / WORKERS_PER_TIER) + 1 }));

      const now = new Date().toISOString();
      const rows = offers.map((o) => ({
        work_order_id, worker_id: o.worker.id, tier: o.tier, score: o.score,
        status: o.tier === 1 ? "sent" : "queued",
        sent_at: o.tier === 1 ? now : null,
      }));
      await fetch(`${supabaseUrl}/rest/v1/job_offers`, { method: "POST", headers: adminHeaders, body: JSON.stringify(rows) });

      const tier1Workers = offers.filter((o) => o.tier === 1).map((o) => o.worker);
      await sendOfferEmails(tier1Workers, { ...wo, is_urgent: isUrgent }, address, unitNumber);
      await logAudit("work_order.dispatched", work_order_id, { tier1_count: tier1Workers.length, total_eligible: scored.length, is_urgent: isUrgent, category, zone });

      return new Response(JSON.stringify({ ok: true, dispatched: tier1Workers.length, total_eligible: scored.length, is_urgent: isUrgent }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ---- Appelée par pg_cron : fait avancer les paliers en attente de réponse ----
    if (action === "advance") {
      const results: Record<string, unknown>[] = [];

      // Work orders encore non assignés, dont le palier courant est
      // expiré (délai dépassé sans acceptation).
      const activeRes = await fetch(
        `${supabaseUrl}/rest/v1/work_orders?worker_id=is.null&dispatch_mode=eq.auto&dispatch_escalated=eq.false&select=id,is_urgent,dispatch_started_at,units(unit_number,buildings(address))`,
        { headers: adminHeaders },
      );
      const activeOrders = await activeRes.json().catch(() => []);

      for (const wo of Array.isArray(activeOrders) ? activeOrders : []) {
        const timeoutMinutes = wo.is_urgent ? URGENT_TIMEOUT_MINUTES : NORMAL_TIER_TIMEOUT_MINUTES;
        const offersRes = await fetch(`${supabaseUrl}/rest/v1/job_offers?work_order_id=eq.${wo.id}&select=*&order=tier.asc`, { headers: adminHeaders });
        const offers = await offersRes.json().catch(() => []);
        if (!Array.isArray(offers) || !offers.length) continue;

        const sentOffers = offers.filter((o: any) => o.status === "sent");
        const stillWaiting = sentOffers.some((o: any) => new Date(o.sent_at).getTime() > Date.now() - timeoutMinutes * 60000);
        if (sentOffers.length && stillWaiting) continue; // palier courant toujours dans son délai

        if (sentOffers.length) {
          await fetch(`${supabaseUrl}/rest/v1/job_offers?work_order_id=eq.${wo.id}&status=eq.sent`, {
            method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "expired", responded_at: new Date().toISOString() }),
          });
        }

        const nextTierOffers = offers.filter((o: any) => o.status === "queued");
        if (nextTierOffers.length) {
          const nextTier = Math.min(...nextTierOffers.map((o: any) => o.tier));
          const toSend = nextTierOffers.filter((o: any) => o.tier === nextTier);
          for (const o of toSend) {
            await fetch(`${supabaseUrl}/rest/v1/job_offers?id=eq.${o.id}`, {
              method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "sent", sent_at: new Date().toISOString() }),
            });
          }
          const workersRes = await fetch(`${supabaseUrl}/rest/v1/workers?id=in.(${toSend.map((o: any) => o.worker_id).join(",")})&select=id,name,email`, { headers: adminHeaders });
          const workers = await workersRes.json().catch(() => []);
          const woDetailRes = await fetch(`${supabaseUrl}/rest/v1/work_orders?id=eq.${wo.id}&select=description,worker_pay`, { headers: adminHeaders });
          const [woDetail] = await woDetailRes.json().catch(() => [null]);
          await sendOfferEmails(workers, { ...woDetail, is_urgent: wo.is_urgent }, wo.units?.buildings?.address ?? "", wo.units?.unit_number ?? "");
          results.push({ work_order_id: wo.id, advanced_to_tier: nextTier, notified: toSend.length });
        } else {
          await fetch(`${supabaseUrl}/rest/v1/work_orders?id=eq.${wo.id}`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ dispatch_escalated: true }) });
          await notifyAdmins(
            `Aucun travailleur n'a accepté — ${wo.units?.buildings?.address ?? ""}, unité ${wo.units?.unit_number ?? ""}`,
            `Tous les paliers de travailleurs admissibles ont été sollicités sans acceptation. Assignation manuelle requise dans le portail admin.`,
          );
          await logAudit("work_order.dispatch_escalated_to_admin", wo.id, {});
          results.push({ work_order_id: wo.id, escalated: true });
        }
      }

      return new Response(JSON.stringify({ ok: true, results }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
