// Outillage Loi 25 — aucune IA ici, tout est saisi ou décidé par un
// humain. Ce module ne fait qu'exécuter des actions déterministes une
// fois qu'un admin a qualifié un incident ou reçu une demande d'une
// personne concernée (la vérification d'identité du demandeur reste un
// acte humain, hors de ce système).
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
    // Durcissement (Lot 7 TWIM) : ces en-têtes ne coûtent rien et
    // réduisent la surface d'attaque même si le contenu JSON renvoyé
    // n'est pas du HTML — défense en profondeur, pas une réaction à un
    // vecteur d'attaque identifié ici.
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
}

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
  const corsHeaders = corsHeadersFor(req.headers.get("origin"));
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

    // Efface tous les fichiers d'un bucket sous un préfixe donné (ex.
    // "workers/<id>" ou l'UUID du propriétaire) — sans ça, l'effacement
    // ne touchait que les colonnes texte des tables, jamais les fichiers
    // réels (baux, reçus, photos) qui restaient dans le stockage.
    async function deleteStorageByPrefix(bucket: string, prefix: string): Promise<number> {
      const listRes = await fetch(`${supabaseUrl}/storage/v1/object/list/${bucket}`, {
        method: "POST", headers: adminHeaders,
        body: JSON.stringify({ prefix, limit: 1000 }),
      });
      const objects = await listRes.json().catch(() => []);
      const names = (Array.isArray(objects) ? objects : [])
        .filter((o: any) => o?.name)
        .map((o: any) => `${prefix}/${o.name}`);
      if (!names.length) return 0;
      const deleteRes = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}`, {
        method: "DELETE", headers: adminHeaders,
        body: JSON.stringify({ prefixes: names }),
      });
      if (!deleteRes.ok) {
        console.error("deleteStorageByPrefix failed", bucket, prefix, deleteRes.status, await deleteRes.text().catch(() => ""));
        return 0;
      }
      return names.length;
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
        // Effacement en cascade — pas seulement le nom/courriel/téléphone
        // sur la fiche elle-même, mais aussi les fichiers réels dans le
        // stockage et le contenu textuel libre des enregistrements liés
        // (susceptible de contenir des renseignements personnels écrits
        // par la personne elle-même). Les registres de sécurité/traçabilité
        // (audit_log, ai_run_log, automated_decisions) sont volontairement
        // préservés — leur conservation répond à une autre obligation
        // légale (imputabilité) ; leur durée de rétention propre est une
        // question distincte, à trancher avec un conseiller juridique.
        const anonymizeMap: Record<string, { table: string; patch: Record<string, unknown> }> = {
          tenant: { table: "tenants", patch: { full_name: "Locataire anonymisé", email: null, phone: null, anonymized_at: new Date().toISOString() } },
          prospect: { table: "prospects", patch: { full_name: "Prospect anonymisé", email: null, phone: null, company_name: null, notes: null, call_history: [], anonymized_at: new Date().toISOString() } },
          owner: { table: "owners", patch: { full_name: "Propriétaire anonymisé", phone: null, company_name: null } },
          worker: { table: "workers", patch: { name: "Travailleur anonymisé", phone: null, email: null } },
        };
        const target = anonymizeMap[subject_type];
        if (!target) {
          return new Response(JSON.stringify({ error: "Type de sujet non pris en charge pour l'anonymisation" }), { status: 400, headers: corsHeaders });
        }
        const anonymizeRes = await fetch(`${supabaseUrl}/rest/v1/${target.table}?id=eq.${subject_id}`, {
          method: "PATCH", headers: adminHeaders, body: JSON.stringify(target.patch),
        });
        if (!anonymizeRes.ok) {
          console.error(`Failed to anonymize ${target.table}/${subject_id}`, await anonymizeRes.text());
          return new Response(JSON.stringify({ error: "L'anonymisation a échoué — la demande reste ouverte, réessaie." }), { status: 500, headers: corsHeaders });
        }

        let filesDeleted = 0;
        if (subject_type === "owner") {
          filesDeleted += await deleteStorageByPrefix("documents", subject_id);
          // Les lignes "documents" elles-mêmes ne sont pas supprimées
          // (elles restent la trace qu'un bail/mandat a existé et à quelle
          // date), mais tout champ dérivé du contenu réel est effacé en
          // même temps que le fichier source.
          await fetch(`${supabaseUrl}/rest/v1/documents?owner_id=eq.${subject_id}`, {
            method: "PATCH", headers: adminHeaders,
            body: JSON.stringify({ title: "Document supprimé (demande d'effacement)", file_url: null, ai_summary: null, ai_parties: null, ai_key_amount: null, ai_expiry_date: null, ai_extracted: null }),
          });
          await fetch(`${supabaseUrl}/rest/v1/messages?owner_id=eq.${subject_id}`, {
            method: "PATCH", headers: adminHeaders,
            body: JSON.stringify({ body: "[message supprimé — demande d'effacement]" }),
          });
        } else if (subject_type === "tenant") {
          filesDeleted += await deleteStorageByPrefix("service-request-photos", subject_id);
        } else if (subject_type === "worker") {
          filesDeleted += await deleteStorageByPrefix("documents", `workers/${subject_id}`);
          // documents n'a pas de colonne worker_id — le document
          // d'assurance d'un travailleur est référencé depuis
          // workers.insurance_document_id, pas l'inverse.
          const workerRes = await fetch(`${supabaseUrl}/rest/v1/workers?id=eq.${subject_id}&select=insurance_document_id`, { headers: adminHeaders });
          const [workerRow] = await workerRes.json().catch(() => [null]);
          if (workerRow?.insurance_document_id) {
            await fetch(`${supabaseUrl}/rest/v1/documents?id=eq.${workerRow.insurance_document_id}`, {
              method: "PATCH", headers: adminHeaders,
              body: JSON.stringify({ title: "Document supprimé (demande d'effacement)", file_url: null, ai_summary: null, ai_parties: null, ai_key_amount: null, ai_expiry_date: null, ai_extracted: null }),
            });
          }
        }

        const fulfilledRes = await fetch(`${supabaseUrl}/rest/v1/personal_data_requests?id=eq.${request_id}`, {
          method: "PATCH", headers: adminHeaders,
          body: JSON.stringify({ status: "fulfilled", handled_by: userId, handled_at: new Date().toISOString(), resolution_note: `Anonymisation appliquée, ${filesDeleted} fichier(s) supprimé(s) du stockage` }),
        });
        if (!fulfilledRes.ok) {
          console.error("Failed to mark data request fulfilled", await fulfilledRes.text());
          return new Response(JSON.stringify({ error: "Anonymisation appliquée, mais la mise à jour du statut de la demande a échoué." }), { status: 500, headers: corsHeaders });
        }
        await logAudit("data_request.fulfilled", "personal_data_requests", request_id, { request_type, subject_type, subject_id, files_deleted: filesDeleted });
        return new Response(JSON.stringify({ ok: true, action_taken: "anonymized", files_deleted: filesDeleted }), { status: 200, headers: corsHeaders });
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
