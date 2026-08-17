// Portail Pro — portail persistant des travailleurs autonomes. Sur le
// modèle de caller-api.ts (compte "worker" avec vrai mot de passe, pas de
// lien à usage unique) : chaque action vérifie explicitement que la
// ressource visée (offre, work order) appartient bien au travailleur
// connecté avant d'y toucher.
//
// L'acceptation d'une offre passe par la fonction Postgres
// accept_job_offer() (verrous de lignes) plutôt que par un simple UPDATE
// ici, pour garantir "premier arrivé, premier servi" même si deux
// travailleurs cliquent en même temps.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ALLOWED_AVAILABILITY = ["maintenant", "aujourdhui", "semaine", "indisponible"];

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
  const res = await fetch(`${supabaseUrl}/auth/v1/jwks`);
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
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const workerRes = await fetch(`${supabaseUrl}/rest/v1/workers?user_id=eq.${userId}&select=*`, { headers: adminHeaders });
    const [worker] = await workerRes.json().catch(() => [null]);
    if (!worker) {
      return new Response(JSON.stringify({ error: "Accès refusé — aucun profil travailleur associé à ce compte" }), { status: 403, headers: corsHeaders });
    }
    if (worker.active === false) {
      return new Response(JSON.stringify({ error: "Ton compte est désactivé — contacte l'équipe Portail" }), { status: 403, headers: corsHeaders });
    }
    const workerId = worker.id;

    const logAudit = (action: string, entityType: string, entityId: string | null, details: Record<string, unknown>) =>
      fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ actor_type: "worker", actor_id: userId, action, entity_type: entityType, entity_id: entityId, details }),
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

    const body = await req.json().catch(() => ({}));
    const action = body.action || "get_my_profile";

    if (action === "get_my_profile") {
      const verifRes = await fetch(`${supabaseUrl}/rest/v1/worker_verification_status?id=eq.${workerId}&select=*`, { headers: adminHeaders });
      const [profile] = await verifRes.json().catch(() => [worker]);
      return new Response(JSON.stringify({ worker: profile || worker }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "update_my_profile") {
      const { company_name, neq, specialties, zones, hourly_rate, travel_fee, handles_urgent, payout_email, availability_schedule } = body;
      const patch: Record<string, unknown> = {};
      if (company_name !== undefined) patch.company_name = company_name || null;
      if (neq !== undefined) patch.neq = neq || null;
      if (Array.isArray(specialties)) patch.specialties = specialties;
      if (Array.isArray(zones)) patch.zones = zones;
      if (hourly_rate !== undefined) patch.hourly_rate = hourly_rate === "" || hourly_rate === null ? null : Number(hourly_rate);
      if (travel_fee !== undefined) patch.travel_fee = travel_fee === "" || travel_fee === null ? null : Number(travel_fee);
      if (handles_urgent !== undefined) patch.handles_urgent = !!handles_urgent;
      if (payout_email !== undefined) patch.payout_email = payout_email || null;
      if (availability_schedule !== undefined && typeof availability_schedule === "object") patch.availability_schedule = availability_schedule;

      await fetch(`${supabaseUrl}/rest/v1/workers?id=eq.${workerId}`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify(patch) });
      await logAudit("worker.profile_updated", "workers", workerId, { fields: Object.keys(patch) });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    // Bascule rapide (un clic) — distincte de update_my_profile pour ne
    // jamais avoir à repasser par tout le formulaire juste pour se
    // déclarer disponible/indisponible.
    if (action === "set_availability_status") {
      const { availability_status } = body;
      if (!ALLOWED_AVAILABILITY.includes(availability_status)) {
        return new Response(JSON.stringify({ error: "Statut de disponibilité invalide" }), { status: 400, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/workers?id=eq.${workerId}`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ availability_status }) });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    // Preuve d'assurance ou référence/photo — réutilise le stockage
    // "documents" déjà en place, avec worker_id plutôt qu'owner_id.
    if (action === "upload_credential_document") {
      const { doc_type, file_base64, filename, content_type } = body;
      if (!["assurance_travailleur", "reference_travailleur"].includes(doc_type) || !file_base64) {
        return new Response(JSON.stringify({ error: "doc_type ou fichier manquant" }), { status: 400, headers: corsHeaders });
      }
      const path = `workers/${workerId}/${Date.now()}-${(filename || "document").replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
      const bytes = Uint8Array.from(atob(file_base64), (c) => c.charCodeAt(0));
      const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/documents/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey ?? "", "Content-Type": content_type || "application/octet-stream" },
        body: bytes,
      });
      if (!uploadRes.ok) {
        return new Response(JSON.stringify({ error: "Échec du téléversement" }), { status: 500, headers: corsHeaders });
      }
      const docRes = await fetch(`${supabaseUrl}/rest/v1/documents`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "return=representation" },
        body: JSON.stringify({ worker_id: workerId, title: filename || doc_type, doc_type, file_url: path }),
      });
      const [doc] = await docRes.json().catch(() => [null]);
      if (doc_type === "assurance_travailleur" && doc?.id) {
        await fetch(`${supabaseUrl}/rest/v1/workers?id=eq.${workerId}`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ insurance_document_id: doc.id }) });
      }
      await logAudit("worker.document_uploaded", "workers", workerId, { doc_type });
      return new Response(JSON.stringify({ ok: true, document_id: doc?.id ?? null }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "list_my_offers") {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/job_offers?worker_id=eq.${workerId}&status=eq.sent&select=id,tier,score,sent_at,work_orders(id,description,worker_pay,is_urgent,units(unit_number,buildings(address)))&order=sent_at.desc`,
        { headers: adminHeaders },
      );
      const offers = await res.json().catch(() => []);
      return new Response(JSON.stringify({ offers }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "accept_offer") {
      const { offer_id } = body;
      if (!offer_id) {
        return new Response(JSON.stringify({ error: "offer_id requis" }), { status: 400, headers: corsHeaders });
      }
      const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/accept_job_offer`, {
        method: "POST", headers: adminHeaders, body: JSON.stringify({ p_offer_id: offer_id, p_worker_id: workerId }),
      });
      const result = await rpcRes.json().catch(() => ({ ok: false, error: "Erreur inattendue" }));
      if (result?.ok) {
        await logAudit("work_order.worker_accepted_offer", "work_orders", result.work_order_id, { offer_id });
      }
      return new Response(JSON.stringify(result), { status: result?.ok ? 200 : 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "decline_offer") {
      const { offer_id } = body;
      const offerRes = await fetch(`${supabaseUrl}/rest/v1/job_offers?id=eq.${offer_id}&worker_id=eq.${workerId}&select=id,status`, { headers: adminHeaders });
      const [offer] = await offerRes.json().catch(() => [null]);
      if (!offer) {
        return new Response(JSON.stringify({ error: "Offre introuvable" }), { status: 404, headers: corsHeaders });
      }
      if (offer.status !== "sent") {
        return new Response(JSON.stringify({ error: "Cette offre n'est plus active" }), { status: 409, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/job_offers?id=eq.${offer_id}`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "declined", responded_at: new Date().toISOString() }) });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "list_my_jobs") {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/work_orders?worker_id=eq.${workerId}&select=id,description,worker_pay,status,appointment_at,worker_reported_done_at,photo_before_urls,photo_after_urls,units(unit_number,buildings(address))&order=created_at.desc`,
        { headers: adminHeaders },
      );
      const jobs = await res.json().catch(() => []);
      return new Response(JSON.stringify({ jobs }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "submit_completion") {
      const { work_order_id, message, before_photos, after_photos } = body;
      const woRes = await fetch(`${supabaseUrl}/rest/v1/work_orders?id=eq.${work_order_id}&worker_id=eq.${workerId}&select=id,worker_reported_done_at,description,units(unit_number,buildings(address))`, { headers: adminHeaders });
      const [wo] = await woRes.json().catch(() => [null]);
      if (!wo) {
        return new Response(JSON.stringify({ error: "Ce travail ne t'est pas assigné" }), { status: 403, headers: corsHeaders });
      }
      if (wo.worker_reported_done_at) {
        return new Response(JSON.stringify({ error: "La fin des travaux a déjà été signalée pour ce travail" }), { status: 409, headers: corsHeaders });
      }

      const uploadPhotos = async (photos: Array<{ base64: string; filename?: string; content_type?: string }> | undefined, subfolder: string) => {
        const paths: string[] = [];
        for (const p of (Array.isArray(photos) ? photos : []).slice(0, 5)) {
          if (!p?.base64) continue;
          const path = `work-orders/${work_order_id}/${subfolder}/${Date.now()}-${(p.filename || "photo.jpg").replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
          const bytes = Uint8Array.from(atob(p.base64), (c) => c.charCodeAt(0));
          const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/service-request-photos/${path}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey ?? "", "Content-Type": p.content_type || "application/octet-stream" },
            body: bytes,
          });
          if (uploadRes.ok) paths.push(path);
        }
        return paths;
      };

      const beforeUrls = await uploadPhotos(before_photos, "avant");
      const afterUrls = await uploadPhotos(after_photos, "apres");
      if (!beforeUrls.length && !afterUrls.length) {
        return new Response(JSON.stringify({ error: "Au moins une photo est requise" }), { status: 400, headers: corsHeaders });
      }

      await fetch(`${supabaseUrl}/rest/v1/work_orders?id=eq.${work_order_id}`, {
        method: "PATCH", headers: adminHeaders,
        body: JSON.stringify({ photo_before_urls: beforeUrls, photo_after_urls: afterUrls, worker_reported_done_at: new Date().toISOString(), worker_completion_note: message || null }),
      });

      await logAudit("work_order.worker_reported_done", "work_orders", work_order_id, { photos_before: beforeUrls.length, photos_after: afterUrls.length });
      await notifyAdmins(
        `Travail terminé (signalé par le travailleur) — ${wo.units?.buildings?.address ?? ""}`,
        `${worker.name} a signalé avoir terminé : ${wo.description}\n${message ? "Note : " + message + "\n" : ""}Photos avant : ${beforeUrls.length}, après : ${afterUrls.length}\n\nEntre le coût final dans le portail admin pour clore le dossier et aviser le locataire.`,
      );
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "get_my_stats") {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/worker_verification_status?id=eq.${workerId}&select=rating,completed_jobs_count,declined_jobs_count,jobs_offered_count,jobs_accepted_count,jobs_cancelled_count,verification_status`,
        { headers: adminHeaders },
      );
      const [stats] = await res.json().catch(() => [null]);
      return new Response(JSON.stringify({ stats }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
