// Outillage Loi 25 — aucune IA ici, tout est saisi ou décidé par un
// humain. Ce module ne fait qu'exécuter des actions déterministes une
// fois qu'un admin a qualifié un incident ou reçu une demande d'une
// personne concernée (la vérification d'identité du demandeur reste un
// acte humain, hors de ce système).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Vérifie la signature du JWT (HS256, secret du projet Supabase) au lieu
// de se fier uniquement au réglage "Verify JWT" de la plateforme —
// défense en profondeur : cette fonction reste sûre même si ce réglage
// est mal configuré pour une fonction en particulier.
async function verifySupabaseJwt(jwt: string, jwtSecret: string): Promise<{ sub: string; [key: string]: unknown } | null> {
  const parts = jwt.split(".");
  if (parts.length !== 3 || !jwtSecret) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(jwtSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlToBytes(signatureB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadB64)));
    if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
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
    const claims = await verifySupabaseJwt(jwt, jwtSecret);
    if (!claims) {
      return new Response(JSON.stringify({ error: "Jeton invalide ou expiré" }), { status: 401, headers: corsHeaders });
    }
    const userId = claims.sub as string;

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
    const action = body.action;

    if (action === "list_incidents") {
      const res = await fetch(`${supabaseUrl}/rest/v1/privacy_incidents?select=*&order=discovered_at.desc`, { headers: adminHeaders });
      return new Response(JSON.stringify({ incidents: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "log_incident") {
      const { description, affected_data_categories, affected_people_estimate, risk_of_serious_harm, containment_measures } = body;
      if (!description) {
        return new Response(JSON.stringify({ error: "Description requise" }), { status: 400, headers: corsHeaders });
      }
      const insertRes = await fetch(`${supabaseUrl}/rest/v1/privacy_incidents`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "return=representation" },
        body: JSON.stringify({
          description, affected_data_categories: affected_data_categories || null,
          affected_people_estimate: affected_people_estimate || null,
          risk_of_serious_harm: !!risk_of_serious_harm,
          containment_measures: containment_measures || null,
          logged_by: userId,
        }),
      });
      const [incident] = await insertRes.json();
      await logAudit("privacy_incident.logged", "privacy_incidents", incident?.id ?? null, { risk_of_serious_harm: !!risk_of_serious_harm });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "update_incident") {
      const { incident_id, status, cai_notified, affected_people_notified, containment_measures } = body;
      if (!incident_id) {
        return new Response(JSON.stringify({ error: "incident_id manquant" }), { status: 400, headers: corsHeaders });
      }
      const patch: Record<string, unknown> = {};
      if (status !== undefined) patch.status = status;
      if (containment_measures !== undefined) patch.containment_measures = containment_measures || null;
      if (cai_notified === true) { patch.cai_notified = true; patch.cai_notified_at = new Date().toISOString(); }
      if (affected_people_notified === true) { patch.affected_people_notified = true; patch.affected_people_notified_at = new Date().toISOString(); }
      await fetch(`${supabaseUrl}/rest/v1/privacy_incidents?id=eq.${incident_id}`, {
        method: "PATCH", headers: adminHeaders, body: JSON.stringify(patch),
      });
      await logAudit("privacy_incident.updated", "privacy_incidents", incident_id, patch);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "list_data_requests") {
      const res = await fetch(`${supabaseUrl}/rest/v1/personal_data_requests?select=*&order=created_at.desc`, { headers: adminHeaders });
      return new Response(JSON.stringify({ requests: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "log_data_request") {
      const { request_type, subject_type, subject_id, requester_name, requester_email, request_details } = body;
      if (!request_type || !subject_type || !subject_id || !requester_name) {
        return new Response(JSON.stringify({ error: "Champs manquants" }), { status: 400, headers: corsHeaders });
      }
      const insertRes = await fetch(`${supabaseUrl}/rest/v1/personal_data_requests`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "return=representation" },
        body: JSON.stringify({ request_type, subject_type, subject_id, requester_name, requester_email: requester_email || null, request_details: request_details || null }),
      });
      const [reqRow] = await insertRes.json();
      await logAudit("data_request.logged", "personal_data_requests", reqRow?.id ?? null, { request_type, subject_type });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "update_data_request") {
      const { request_id, status, resolution_note } = body;
      if (!request_id) {
        return new Response(JSON.stringify({ error: "request_id manquant" }), { status: 400, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/personal_data_requests?id=eq.${request_id}`, {
        method: "PATCH", headers: adminHeaders,
        body: JSON.stringify({ status: status || undefined, resolution_note: resolution_note ?? undefined, handled_by: userId, handled_at: new Date().toISOString() }),
      });
      await logAudit("data_request.updated", "personal_data_requests", request_id, { status });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "fulfill_data_request") {
      const { request_id } = body;
      if (!request_id) {
        return new Response(JSON.stringify({ error: "request_id manquant" }), { status: 400, headers: corsHeaders });
      }
      const reqRes = await fetch(`${supabaseUrl}/rest/v1/personal_data_requests?id=eq.${request_id}&select=*`, { headers: adminHeaders });
      const [dataRequest] = await reqRes.json();
      if (!dataRequest) {
        return new Response(JSON.stringify({ error: "Demande introuvable" }), { status: 404, headers: corsHeaders });
      }
      const { request_type, subject_type, subject_id } = dataRequest;

      if (request_type === "deletion") {
        const anonymizeMap: Record<string, { table: string; patch: Record<string, unknown> }> = {
          tenant: { table: "tenants", patch: { full_name: "Locataire anonymisé", email: null, phone: null, anonymized_at: new Date().toISOString() } },
          prospect: { table: "prospects", patch: { full_name: "Prospect anonymisé", email: null, phone: null, company_name: null, notes: null, call_history: [], anonymized_at: new Date().toISOString() } },
          owner: { table: "owners", patch: { full_name: "Propriétaire anonymisé", phone: null } },
          worker: { table: "workers", patch: { name: "Travailleur anonymisé", phone: null, email: null } },
        };
        const target = anonymizeMap[subject_type];
        if (!target) {
          return new Response(JSON.stringify({ error: "Type de sujet non pris en charge pour l'anonymisation" }), { status: 400, headers: corsHeaders });
        }
        await fetch(`${supabaseUrl}/rest/v1/${target.table}?id=eq.${subject_id}`, {
          method: "PATCH", headers: adminHeaders, body: JSON.stringify(target.patch),
        });
        await fetch(`${supabaseUrl}/rest/v1/personal_data_requests?id=eq.${request_id}`, {
          method: "PATCH", headers: adminHeaders,
          body: JSON.stringify({ status: "fulfilled", handled_by: userId, handled_at: new Date().toISOString(), resolution_note: "Anonymisation appliquée" }),
        });
        await logAudit("data_request.fulfilled", "personal_data_requests", request_id, { request_type, subject_type, subject_id });
        return new Response(JSON.stringify({ ok: true, action_taken: "anonymized" }), { status: 200, headers: corsHeaders });
      }

      if (request_type === "access") {
        const exportQueries: Record<string, string> = {
          tenant: `${supabaseUrl}/rest/v1/tenants?id=eq.${subject_id}&select=*,leases(*,payments(*),units(unit_number,buildings(address))),service_requests(*)`,
          prospect: `${supabaseUrl}/rest/v1/prospects?id=eq.${subject_id}&select=*`,
          owner: `${supabaseUrl}/rest/v1/owners?id=eq.${subject_id}&select=*,buildings(*,units(*))`,
          worker: `${supabaseUrl}/rest/v1/workers?id=eq.${subject_id}&select=*,work_orders(*)`,
        };
        const q = exportQueries[subject_type];
        if (!q) {
          return new Response(JSON.stringify({ error: "Type de sujet non pris en charge pour l'export" }), { status: 400, headers: corsHeaders });
        }
        const exportRes = await fetch(q, { headers: adminHeaders });
        const exportData = await exportRes.json();
        await fetch(`${supabaseUrl}/rest/v1/personal_data_requests?id=eq.${request_id}`, {
          method: "PATCH", headers: adminHeaders,
          body: JSON.stringify({ status: "fulfilled", handled_by: userId, handled_at: new Date().toISOString(), resolution_note: "Export généré et remis au demandeur" }),
        });
        await logAudit("data_request.fulfilled", "personal_data_requests", request_id, { request_type, subject_type, subject_id });
        return new Response(JSON.stringify({ ok: true, action_taken: "exported", data: exportData }), { status: 200, headers: corsHeaders });
      }

      return new Response(JSON.stringify({ error: "Les demandes de rectification se traitent en corrigeant le dossier directement, puis en fermant la demande via update_data_request." }), { status: 400, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    console.error("privacy-api unexpected error", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
