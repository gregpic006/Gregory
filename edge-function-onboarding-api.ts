const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const OWNER_PORTAL_URL = "https://portailgestion.ca/portail-proprietaire.html";
const TENANT_PORTAL_URL = "https://portailgestion.ca/portail-locataire.html";
const CALLER_PORTAL_URL = "https://portailgestion.ca/portail-cold-caller.html";
const WORKER_PORTAL_URL = "https://portailgestion.ca/portail-travailleur.html";

function randomPassword() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 14);
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

    const sendEmail = (to: string, subject: string, text: string) =>
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: "Portail <onboarding@mail.portailgestion.ca>", to: [to], subject, text }),
      });

    const body = await req.json().catch(() => ({}));
    const action = body.action;

    if (action === "list_owners") {
      const res = await fetch(`${supabaseUrl}/rest/v1/owners?select=id,full_name,company_name&order=full_name.asc`, { headers: adminHeaders });
      return new Response(JSON.stringify({ owners: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "list_buildings") {
      const res = await fetch(`${supabaseUrl}/rest/v1/buildings?owner_id=eq.${body.owner_id}&select=id,address&order=address.asc`, { headers: adminHeaders });
      return new Response(JSON.stringify({ buildings: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "list_units") {
      const res = await fetch(`${supabaseUrl}/rest/v1/units?building_id=eq.${body.building_id}&select=id,unit_number,status&order=unit_number.asc`, { headers: adminHeaders });
      return new Response(JSON.stringify({ units: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Retrouve le courriel de connexion actuel d'un propriétaire à partir
    // de son owner_id — utile quand on ne sait pas si l'owner a été créé
    // sous un courriel différent de celui attendu (ex: réutilisation d'une
    // ancienne ligne de données de démonstration).
    if (action === "get_owner_login") {
      const { owner_id } = body;
      if (!owner_id) {
        return new Response(JSON.stringify({ error: "owner_id requis" }), { status: 400, headers: corsHeaders });
      }
      const ownerRes = await fetch(`${supabaseUrl}/rest/v1/owners?id=eq.${owner_id}&select=id,full_name,user_id`, { headers: adminHeaders });
      const [owner] = await ownerRes.json().catch(() => [null]);
      if (!owner) {
        return new Response(JSON.stringify({ error: "Propriétaire introuvable" }), { status: 404, headers: corsHeaders });
      }
      let email: string | null = null;
      if (owner.user_id) {
        const userRes = await fetch(`${supabaseUrl}/rest/v1/users?id=eq.${owner.user_id}&select=email`, { headers: adminHeaders });
        const [userRow] = await userRes.json().catch(() => [null]);
        email = userRow?.email ?? null;
      }
      return new Response(JSON.stringify({ owner_id: owner.id, full_name: owner.full_name, user_id: owner.user_id, email }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Change le courriel de connexion ET remet un nouveau mot de passe
    // temporaire pour un propriétaire déjà créé — utile pour corriger une
    // ligne réutilisée depuis une ancienne donnée de démonstration sans
    // devoir migrer tout son immeuble/unités vers un nouveau compte.
    if (action === "update_owner_login") {
      const { owner_id, email } = body;
      if (!owner_id || !email) {
        return new Response(JSON.stringify({ error: "owner_id et email requis" }), { status: 400, headers: corsHeaders });
      }
      const ownerRes = await fetch(`${supabaseUrl}/rest/v1/owners?id=eq.${owner_id}&select=id,user_id`, { headers: adminHeaders });
      const [owner] = await ownerRes.json().catch(() => [null]);
      if (!owner || !owner.user_id) {
        return new Response(JSON.stringify({ error: "Propriétaire ou compte introuvable" }), { status: 404, headers: corsHeaders });
      }
      const password = randomPassword();
      const authRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${owner.user_id}`, {
        method: "PUT",
        headers: adminHeaders,
        body: JSON.stringify({ email, password, email_confirm: true }),
      });
      const authData = await authRes.json().catch(() => ({}));
      if (!authRes.ok) {
        return new Response(JSON.stringify({ error: authData.msg || authData.error_description || "Impossible de mettre à jour le compte" }), { status: 400, headers: corsHeaders });
      }
      await logAudit("owner.update_login", "owners", owner_id, { new_email: email });
      return new Response(JSON.stringify({ ok: true, email, temp_password: password }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "find_owner_by_email") {
      const res = await fetch(`${supabaseUrl}/rest/v1/users?email=eq.${encodeURIComponent(body.email)}&role=eq.owner&select=id`, { headers: adminHeaders });
      const [userRow] = await res.json();
      if (!userRow) return new Response(JSON.stringify({ owner: null }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const ownerRes = await fetch(`${supabaseUrl}/rest/v1/owners?user_id=eq.${userRow.id}&select=id,full_name`, { headers: adminHeaders });
      const [owner] = await ownerRes.json();
      return new Response(JSON.stringify({ owner: owner || null }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Aide au nettoyage manuel : montre ce qui reste dans les tables
    // souvent polluées par les tests (anomalies, prospects, journal
    // d'audit), avec assez de contexte pour distinguer une vraie donnée
    // (ex: propriétaire Gregory) d'un reste de diagnostic — sans rien
    // supprimer automatiquement.
    if (action === "inspect_test_data") {
      const anomaliesRes = await fetch(
        `${supabaseUrl}/rest/v1/financial_anomalies?select=id,type,severity,description,status,created_at,owners(full_name)&order=created_at.desc`,
        { headers: adminHeaders },
      );
      const prospectsRes = await fetch(
        `${supabaseUrl}/rest/v1/prospects?select=id,full_name,email,company_name,stage,created_at&order=created_at.desc`,
        { headers: adminHeaders },
      );

      // Une ligne d'audit_log est "orpheline" si l'entité qu'elle décrit
      // n'existe plus (ex: owner.create pour un propriétaire déjà
      // supprimé) — donc sans risque de retirer une vraie trace encore
      // pertinente.
      const auditRes = await fetch(`${supabaseUrl}/rest/v1/audit_log?select=id,action,entity_type,entity_id,created_at&order=created_at.desc&limit=1000`, { headers: adminHeaders });
      const auditRows = await auditRes.json().catch(() => []);
      const byType: Record<string, Set<string>> = {};
      for (const row of auditRows) {
        if (!row.entity_type || !row.entity_id) continue;
        (byType[row.entity_type] ??= new Set()).add(row.entity_id);
      }
      const tableForEntityType: Record<string, string> = {
        owners: "owners", buildings: "buildings", units: "units", tenants: "tenants",
        work_orders: "work_orders", service_requests: "service_requests", prospects: "prospects",
      };
      const existingIds: Record<string, Set<string>> = {};
      for (const [entityType, ids] of Object.entries(byType)) {
        const table = tableForEntityType[entityType];
        if (!table) continue;
        const idsRes = await fetch(`${supabaseUrl}/rest/v1/${table}?id=in.(${[...ids].join(",")})&select=id`, { headers: adminHeaders });
        const rows = await idsRes.json().catch(() => []);
        existingIds[entityType] = new Set(rows.map((r: any) => r.id));
      }
      const orphanedAuditIds = auditRows
        .filter((row: any) => row.entity_type && row.entity_id && tableForEntityType[row.entity_type] && !existingIds[row.entity_type]?.has(row.entity_id))
        .map((row: any) => row.id);

      return new Response(JSON.stringify({
        financial_anomalies: await anomaliesRes.json().catch(() => []),
        prospects: await prospectsRes.json().catch(() => []),
        audit_log_total: auditRows.length,
        audit_log_orphaned_count: orphanedAuditIds.length,
        audit_log_orphaned_ids: orphanedAuditIds,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Supprime uniquement les lignes audit_log dont l'entité décrite
    // n'existe plus (voir inspect_test_data) — jamais les traces
    // d'entités toujours actives.
    if (action === "purge_orphaned_audit_log") {
      const { ids } = body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return new Response(JSON.stringify({ error: "ids requis (tableau non vide)" }), { status: 400, headers: corsHeaders });
      }
      const res = await fetch(`${supabaseUrl}/rest/v1/audit_log?id=in.(${ids.join(",")})`, {
        method: "DELETE",
        headers: { ...adminHeaders, Prefer: "return=representation" },
      });
      const rows = await res.json().catch(() => []);
      return new Response(JSON.stringify({ ok: res.ok, deleted: Array.isArray(rows) ? rows.length : 0 }), { status: res.ok ? 200 : 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Supprime des lignes précises de financial_anomalies ou prospects,
    // choisies après revue manuelle via inspect_test_data.
    if (action === "delete_rows") {
      const { table, ids } = body;
      const allowed = ["financial_anomalies", "prospects"];
      if (!allowed.includes(table) || !Array.isArray(ids) || ids.length === 0) {
        return new Response(JSON.stringify({ error: "table (financial_anomalies|prospects) et ids requis" }), { status: 400, headers: corsHeaders });
      }
      const res = await fetch(`${supabaseUrl}/rest/v1/${table}?id=in.(${ids.join(",")})`, {
        method: "DELETE",
        headers: { ...adminHeaders, Prefer: "return=representation" },
      });
      const rows = await res.json().catch(() => []);
      return new Response(JSON.stringify({ ok: res.ok, deleted: Array.isArray(rows) ? rows.length : 0 }), { status: res.ok ? 200 : 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "find_tenant_by_email") {
      const res = await fetch(`${supabaseUrl}/rest/v1/tenants?email=eq.${encodeURIComponent(body.email)}&select=id,full_name`, { headers: adminHeaders });
      const [tenant] = await res.json();
      return new Response(JSON.stringify({ tenant: tenant || null }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Purge des données créées par le diagnostic E2E (scripts/e2e-diagnostic.mjs) —
    // repère par les identifiants statiques utilisés uniquement par ce script
    // (jamais par un vrai client), supprime dans l'ordre des clés étrangères,
    // et ferme aussi les comptes Auth créés pour les tests. Idempotent : si
    // rien ne correspond, ne fait rien.
    if (action === "cleanup_e2e_diagnostic_data") {
      const TEST_OWNER_EMAIL = "e2e-owner@portail-diagnostic.internal";
      const TEST_TENANT_PATTERN = "e2e-tenant-*@portail-diagnostic.internal";
      const TEST_MANDAT_PATTERN = "e2e-mandat-*@portail-diagnostic.internal";
      const summary: Record<string, number> = {};

      const del = async (table: string, query: string) => {
        const res = await fetch(`${supabaseUrl}/rest/v1/${table}?${query}`, {
          method: "DELETE",
          headers: { ...adminHeaders, Prefer: "return=representation" },
        });
        const rows = await res.json().catch(() => []);
        const count = Array.isArray(rows) ? rows.length : 0;
        summary[table] = (summary[table] || 0) + count;
        return Array.isArray(rows) ? rows : [];
      };
      const deleteAuthUser = async (id: string) => {
        await fetch(`${supabaseUrl}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: adminHeaders }).catch(() => null);
        summary.auth_users = (summary.auth_users || 0) + 1;
      };

      // Locataires de test et tout ce qui en dépend.
      const tenantsRes = await fetch(`${supabaseUrl}/rest/v1/tenants?email=like.${encodeURIComponent(TEST_TENANT_PATTERN)}&select=id,user_id`, { headers: adminHeaders });
      const tenants = await tenantsRes.json().catch(() => []);
      for (const t of tenants) {
        const leasesRes = await fetch(`${supabaseUrl}/rest/v1/leases?tenant_id=eq.${t.id}&select=id`, { headers: adminHeaders });
        const leases = await leasesRes.json().catch(() => []);
        for (const l of leases) await del("payments", `lease_id=eq.${l.id}`);
        await del("leases", `tenant_id=eq.${t.id}`);
        await del("service_requests", `tenant_id=eq.${t.id}`);
        await del("tenants", `id=eq.${t.id}`);
        if (t.user_id) await deleteAuthUser(t.user_id);
      }

      // Propriétaire de test, son immeuble, ses unités et tout ce qui en dépend.
      const ownerUserRes = await fetch(`${supabaseUrl}/rest/v1/users?email=eq.${encodeURIComponent(TEST_OWNER_EMAIL)}&select=id`, { headers: adminHeaders });
      const [ownerUser] = await ownerUserRes.json().catch(() => [null]);
      if (ownerUser) {
        const ownerRes = await fetch(`${supabaseUrl}/rest/v1/owners?user_id=eq.${ownerUser.id}&select=id`, { headers: adminHeaders });
        const [owner] = await ownerRes.json().catch(() => [null]);
        if (owner) {
          // Sans ceci, la suppression des dépenses/travaux/propriétaire
          // plus bas échoue silencieusement (ces tables référencent
          // owner_id/expense_id/work_order_id sans cascade).
          await del("financial_anomalies", `owner_id=eq.${owner.id}`);
          await del("approvals", `owner_id=eq.${owner.id}`);
          await del("documents", `owner_id=eq.${owner.id}`);

          const buildingsRes = await fetch(`${supabaseUrl}/rest/v1/buildings?owner_id=eq.${owner.id}&select=id`, { headers: adminHeaders });
          const buildings = await buildingsRes.json().catch(() => []);
          for (const b of buildings) {
            const unitsRes = await fetch(`${supabaseUrl}/rest/v1/units?building_id=eq.${b.id}&select=id`, { headers: adminHeaders });
            const units = await unitsRes.json().catch(() => []);
            for (const u of units) {
              const woRes = await fetch(`${supabaseUrl}/rest/v1/work_orders?unit_id=eq.${u.id}&select=id`, { headers: adminHeaders });
              const workOrders = await woRes.json().catch(() => []);
              for (const wo of workOrders) await del("expenses", `work_order_id=eq.${wo.id}`);
              await del("work_orders", `unit_id=eq.${u.id}`);
              await del("service_requests", `unit_id=eq.${u.id}`);
              await del("units", `id=eq.${u.id}`);
            }
            await del("buildings", `id=eq.${b.id}`);
          }
          await del("owners", `id=eq.${owner.id}`);
        }
        await deleteAuthUser(ownerUser.id);
      }

      // Prospects/demandes de mandat créés par le formulaire public de test.
      const prospectsRes = await fetch(`${supabaseUrl}/rest/v1/prospects?email=like.${encodeURIComponent(TEST_MANDAT_PATTERN)}&select=id,inquiry_id`, { headers: adminHeaders });
      const prospects = await prospectsRes.json().catch(() => []);
      for (const p of prospects) {
        await del("prospects", `id=eq.${p.id}`);
        if (p.inquiry_id) await del("inquiries", `id=eq.${p.inquiry_id}`);
      }
      await del("inquiries", `email=like.${encodeURIComponent(TEST_MANDAT_PATTERN)}`);

      return new Response(JSON.stringify({ ok: true, summary }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Suppression complète et ciblée d'un propriétaire (immeubles, unités,
    // travaux, dépenses, demandes de service, baux/paiements en cascade,
    // locataires liés et leur compte Auth). Contrairement à
    // cleanup_e2e_diagnostic_data (qui cible par courriel exact), celle-ci
    // cible par owner_id — utile quand des données de test ont été créées
    // sous un courriel qui ne correspond pas au motif attendu.
    if (action === "delete_owner_completely") {
      const { owner_id } = body;
      if (!owner_id) {
        return new Response(JSON.stringify({ error: "owner_id requis" }), { status: 400, headers: corsHeaders });
      }
      const summary: Record<string, number> = {};
      const errors: string[] = [];
      const del = async (table: string, query: string) => {
        const res = await fetch(`${supabaseUrl}/rest/v1/${table}?${query}`, {
          method: "DELETE",
          headers: { ...adminHeaders, Prefer: "return=representation" },
        });
        const rows = await res.json().catch(() => []);
        if (!res.ok) {
          errors.push(`${table}: ${JSON.stringify(rows)}`);
          return [];
        }
        const count = Array.isArray(rows) ? rows.length : 0;
        summary[table] = (summary[table] || 0) + count;
        return Array.isArray(rows) ? rows : [];
      };
      const deleteAuthUser = async (id: string) => {
        await fetch(`${supabaseUrl}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: adminHeaders }).catch(() => null);
        summary.auth_users = (summary.auth_users || 0) + 1;
      };

      const ownerRes = await fetch(`${supabaseUrl}/rest/v1/owners?id=eq.${owner_id}&select=id,user_id`, { headers: adminHeaders });
      const [owner] = await ownerRes.json().catch(() => [null]);
      if (!owner) {
        return new Response(JSON.stringify({ error: "Propriétaire introuvable" }), { status: 404, headers: corsHeaders });
      }

      // Ces tables référencent owner_id/expense_id/work_order_id SANS
      // suppression en cascade — sans ce nettoyage préalable, la suppression
      // des dépenses/travaux/propriétaire plus bas échoue silencieusement
      // (l'API PostgREST renvoie une erreur, mais rien ne la fait remonter).
      await del("financial_anomalies", `owner_id=eq.${owner_id}`);
      await del("approvals", `owner_id=eq.${owner_id}`);
      await del("documents", `owner_id=eq.${owner_id}`);

      const buildingsRes = await fetch(`${supabaseUrl}/rest/v1/buildings?owner_id=eq.${owner_id}&select=id`, { headers: adminHeaders });
      const buildings = await buildingsRes.json().catch(() => []);
      for (const b of buildings) {
        const unitsRes = await fetch(`${supabaseUrl}/rest/v1/units?building_id=eq.${b.id}&select=id`, { headers: adminHeaders });
        const units = await unitsRes.json().catch(() => []);
        for (const u of units) {
          // Capturer les locataires liés avant que la suppression de
          // l'unité ne fasse disparaître leur bail en cascade.
          const leasesRes = await fetch(`${supabaseUrl}/rest/v1/leases?unit_id=eq.${u.id}&select=tenant_id`, { headers: adminHeaders });
          const leases = await leasesRes.json().catch(() => []);

          const woRes = await fetch(`${supabaseUrl}/rest/v1/work_orders?unit_id=eq.${u.id}&select=id`, { headers: adminHeaders });
          const workOrders = await woRes.json().catch(() => []);
          for (const wo of workOrders) await del("expenses", `work_order_id=eq.${wo.id}`);
          await del("work_orders", `unit_id=eq.${u.id}`);
          await del("service_requests", `unit_id=eq.${u.id}`);
          await del("units", `id=eq.${u.id}`); // cascade : leases -> payments

          for (const l of leases) {
            if (!l.tenant_id) continue;
            const tenantRes = await fetch(`${supabaseUrl}/rest/v1/tenants?id=eq.${l.tenant_id}&select=id,user_id`, { headers: adminHeaders });
            const [tenant] = await tenantRes.json().catch(() => [null]);
            if (tenant) {
              await del("tenants", `id=eq.${tenant.id}`);
              if (tenant.user_id) await deleteAuthUser(tenant.user_id);
            }
          }
        }
        await del("buildings", `id=eq.${b.id}`);
      }
      const deletedOwners = await del("owners", `id=eq.${owner_id}`);
      if (owner.user_id) await deleteAuthUser(owner.user_id);

      await logAudit("owner.delete_cascade", "owners", owner_id, { summary, errors });
      const stillExists = deletedOwners.length === 0;
      return new Response(JSON.stringify({ ok: !stillExists && errors.length === 0, summary, errors }), {
        status: stillExists ? 500 : 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "create_owner") {
      const { full_name, email, phone, company_name, management_rate, spending_cap } = body;
      if (!full_name || !email) {
        return new Response(JSON.stringify({ error: "Nom et courriel requis" }), { status: 400, headers: corsHeaders });
      }
      const password = randomPassword();
      const authRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ email, password, email_confirm: true }),
      });
      const authData = await authRes.json();
      if (!authRes.ok || !authData.id) {
        return new Response(JSON.stringify({ error: authData.msg || authData.error_description || "Impossible de créer le compte" }), { status: 400, headers: corsHeaders });
      }

      const ownerRes = await fetch(`${supabaseUrl}/rest/v1/owners`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "return=representation" },
        body: JSON.stringify({
          user_id: authData.id, full_name, phone: phone || null, company_name: company_name || null,
          management_rate: management_rate || 6.0, spending_cap: spending_cap || 300,
        }),
      });
      const [owner] = await ownerRes.json();

      await sendEmail(email, "Bienvenue sur Portail — ton accès propriétaire",
        `Bonjour ${full_name},\n\nTon compte propriétaire Portail est prêt.\n\nPortail : ${OWNER_PORTAL_URL}\nCourriel : ${email}\nMot de passe temporaire : ${password}\n\nConnecte-toi puis change ton mot de passe si tu le souhaites (lien "Mot de passe oublié" sur la page de connexion).\n\nL'équipe Portail`);

      await logAudit("owner.create", "owners", owner?.id ?? null, { email });
      return new Response(JSON.stringify({ ok: true, owner_id: owner?.id, temp_password: password }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "add_building") {
      const { owner_id, address, unit_count, year_built } = body;
      if (!owner_id || !address) {
        return new Response(JSON.stringify({ error: "Propriétaire et adresse requis" }), { status: 400, headers: corsHeaders });
      }
      const res = await fetch(`${supabaseUrl}/rest/v1/buildings`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "return=representation" },
        body: JSON.stringify({ owner_id, address, unit_count: unit_count || 1, year_built: year_built || null }),
      });
      const [building] = await res.json();
      await logAudit("building.create", "buildings", building?.id ?? null, { address });
      return new Response(JSON.stringify({ ok: true, building_id: building?.id }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "add_unit") {
      const { building_id, unit_number, unit_type, rent, status } = body;
      if (!building_id || !unit_number) {
        return new Response(JSON.stringify({ error: "Immeuble et numéro d'unité requis" }), { status: 400, headers: corsHeaders });
      }
      const res = await fetch(`${supabaseUrl}/rest/v1/units`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "return=representation" },
        body: JSON.stringify({ building_id, unit_number, unit_type: unit_type || null, rent: rent || null, status: status || "occupied" }),
      });
      const [unit] = await res.json();
      await logAudit("unit.create", "units", unit?.id ?? null, { unit_number });
      return new Response(JSON.stringify({ ok: true, unit_id: unit?.id }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "create_tenant") {
      const { full_name, email, phone, unit_id, monthly_rent, start_date, end_date } = body;
      if (!full_name || !unit_id || !monthly_rent || !start_date) {
        return new Response(JSON.stringify({ error: "Champs manquants (nom, unité, loyer, date de début)" }), { status: 400, headers: corsHeaders });
      }

      // Le courriel est optionnel : un locataire réel dont on gère le
      // logement n'a pas nécessairement été informé de ce système et n'a
      // donc pas à recevoir un compte/courriel de bienvenue. Sans courriel,
      // on enregistre seulement le dossier (nom, bail) sans compte Auth.
      let authUserId: string | null = null;
      let tempPassword: string | null = null;
      if (email) {
        tempPassword = randomPassword();
        const authRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
          method: "POST",
          headers: adminHeaders,
          body: JSON.stringify({ email, password: tempPassword, email_confirm: true }),
        });
        const authData = await authRes.json();
        if (!authRes.ok || !authData.id) {
          return new Response(JSON.stringify({ error: authData.msg || authData.error_description || "Impossible de créer le compte" }), { status: 400, headers: corsHeaders });
        }
        authUserId = authData.id;

        // Le déclencheur d'inscription met "owner" par défaut — on corrige pour "tenant".
        await fetch(`${supabaseUrl}/rest/v1/users?id=eq.${authUserId}`, {
          method: "PATCH", headers: adminHeaders, body: JSON.stringify({ role: "tenant" }),
        });
      }

      const tenantRes = await fetch(`${supabaseUrl}/rest/v1/tenants`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "return=representation" },
        body: JSON.stringify({ user_id: authUserId, full_name, email: email || null, phone: phone || null }),
      });
      const [tenant] = await tenantRes.json();

      await fetch(`${supabaseUrl}/rest/v1/leases`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ unit_id, tenant_id: tenant.id, start_date, end_date: end_date || null, monthly_rent, status: "active" }),
      });

      await fetch(`${supabaseUrl}/rest/v1/units?id=eq.${unit_id}`, {
        method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "occupied" }),
      });

      if (email) {
        await sendEmail(email, "Bienvenue sur Portail — ton accès locataire",
          `Bonjour ${full_name},\n\nTon compte locataire Portail est prêt.\n\nPortail : ${TENANT_PORTAL_URL}\nCourriel : ${email}\nMot de passe temporaire : ${tempPassword}\n\nConnecte-toi pour voir ton bail, tes paiements et faire une demande de service. Tu peux changer ton mot de passe via "Mot de passe oublié" sur la page de connexion.\n\nL'équipe Portail`);
      }

      await logAudit("tenant.create", "tenants", tenant?.id ?? null, { email: email || null, unit_id, has_login: !!authUserId });
      return new Response(JSON.stringify({ ok: true, tenant_id: tenant?.id, temp_password: tempPassword }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "create_cold_caller") {
      const { full_name, email, phone } = body;
      if (!full_name || !email) {
        return new Response(JSON.stringify({ error: "Nom et courriel requis" }), { status: 400, headers: corsHeaders });
      }
      const password = randomPassword();
      const authRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ email, password, email_confirm: true }),
      });
      const authData = await authRes.json();
      if (!authRes.ok || !authData.id) {
        return new Response(JSON.stringify({ error: authData.msg || authData.error_description || "Impossible de créer le compte" }), { status: 400, headers: corsHeaders });
      }

      // Le déclencheur d'inscription met "owner" par défaut — on corrige pour "caller".
      await fetch(`${supabaseUrl}/rest/v1/users?id=eq.${authData.id}`, {
        method: "PATCH", headers: adminHeaders, body: JSON.stringify({ role: "caller" }),
      });

      const callerRes = await fetch(`${supabaseUrl}/rest/v1/cold_callers`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "return=representation" },
        body: JSON.stringify({ user_id: authData.id, full_name, phone: phone || null, email }),
      });
      const [caller] = await callerRes.json();

      // On ne fait jamais confiance à l'envoi du courriel : Resend peut
      // échouer silencieusement (ex: domaine expéditeur non vérifié, qui
      // limite l'envoi à l'adresse du compte Resend lui-même). Le mot de
      // passe temporaire est donc TOUJOURS renvoyé dans la réponse — pas
      // seulement quand le courriel échoue — pour que l'admin puisse le
      // communiquer manuellement dans tous les cas.
      let emailSent = false;
      let emailError: string | null = null;
      try {
        const emailRes = await sendEmail(email, "Bienvenue sur Portail — ton accès prospection téléphonique",
          `Bonjour ${full_name},\n\nTon compte Portail pour la prospection téléphonique est prêt.\n\nPortail : ${CALLER_PORTAL_URL}\nCourriel : ${email}\nMot de passe temporaire : ${password}\n\nConnecte-toi pour voir ta file d'appels et logger tes appels. Tu peux changer ton mot de passe via "Mot de passe oublié" sur la page de connexion.\n\nL'équipe Portail`);
        emailSent = emailRes.ok;
        if (!emailRes.ok) {
          const errData = await emailRes.json().catch(() => ({}));
          emailError = errData.message || `Resend a répondu ${emailRes.status}`;
        }
      } catch (e) {
        emailError = String(e);
      }

      await logAudit("cold_caller.create", "cold_callers", caller?.id ?? null, { email, email_sent: emailSent, email_error: emailError });
      return new Response(JSON.stringify({ ok: true, caller_id: caller?.id, temp_password: password, email_sent: emailSent, email_error: emailError }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Régénère un mot de passe temporaire pour un prospecteur téléphonique déjà créé —
    // filet de sécurité si le courriel de bienvenue n'a jamais été reçu
    // (voir la note dans create_cold_caller). Contrairement à
    // update_owner_login, ne change pas le courriel de connexion.
    if (action === "reset_cold_caller_login") {
      const { caller_id } = body;
      if (!caller_id) {
        return new Response(JSON.stringify({ error: "caller_id requis" }), { status: 400, headers: corsHeaders });
      }
      const callerRes = await fetch(`${supabaseUrl}/rest/v1/cold_callers?id=eq.${caller_id}&select=id,user_id,email,full_name`, { headers: adminHeaders });
      const [caller] = await callerRes.json().catch(() => [null]);
      if (!caller || !caller.user_id) {
        return new Response(JSON.stringify({ error: "Prospecteur téléphonique ou compte introuvable" }), { status: 404, headers: corsHeaders });
      }
      const password = randomPassword();
      const authRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${caller.user_id}`, {
        method: "PUT",
        headers: adminHeaders,
        body: JSON.stringify({ password, email_confirm: true }),
      });
      const authData = await authRes.json().catch(() => ({}));
      if (!authRes.ok) {
        return new Response(JSON.stringify({ error: authData.msg || authData.error_description || "Impossible de mettre à jour le compte" }), { status: 400, headers: corsHeaders });
      }
      await logAudit("cold_caller.login_reset", "cold_callers", caller_id, {});
      return new Response(JSON.stringify({ ok: true, email: caller.email, temp_password: password }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Supprime complètement un prospecteur téléphonique (dossier + compte Auth), sur le
    // modèle de delete_owner_completely. Les prospects qui lui étaient
    // assignés ne sont pas supprimés — juste désassignés (ils redeviennent
    // visibles pour l'admin, à réassigner à quelqu'un d'autre au besoin).
    if (action === "delete_cold_caller") {
      const { caller_id } = body;
      if (!caller_id) {
        return new Response(JSON.stringify({ error: "caller_id requis" }), { status: 400, headers: corsHeaders });
      }
      const callerRes = await fetch(`${supabaseUrl}/rest/v1/cold_callers?id=eq.${caller_id}&select=id,user_id,full_name`, { headers: adminHeaders });
      const [caller] = await callerRes.json().catch(() => [null]);
      if (!caller) {
        return new Response(JSON.stringify({ error: "Prospecteur téléphonique introuvable" }), { status: 404, headers: corsHeaders });
      }

      await fetch(`${supabaseUrl}/rest/v1/prospects?assigned_caller_id=eq.${caller_id}`, {
        method: "PATCH", headers: adminHeaders, body: JSON.stringify({ assigned_caller_id: null }),
      });

      const deleteRes = await fetch(`${supabaseUrl}/rest/v1/cold_callers?id=eq.${caller_id}`, {
        method: "DELETE", headers: { ...adminHeaders, Prefer: "return=representation" },
      });
      const deletedRows = await deleteRes.json().catch(() => []);
      if (!deleteRes.ok) {
        return new Response(JSON.stringify({ error: "Impossible de supprimer le dossier du prospecteur téléphonique" }), { status: 500, headers: corsHeaders });
      }
      if (caller.user_id) {
        await fetch(`${supabaseUrl}/auth/v1/admin/users/${caller.user_id}`, { method: "DELETE", headers: adminHeaders }).catch(() => null);
      }

      await logAudit("cold_caller.delete", "cold_callers", caller_id, { full_name: caller.full_name });
      return new Response(JSON.stringify({ ok: true, deleted: Array.isArray(deletedRows) ? deletedRows.length : 0 }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "list_tenants") {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/tenants?select=id,full_name,email,phone,user_id,leases(status,units(unit_number,buildings(address)))&order=full_name.asc`,
        { headers: adminHeaders },
      );
      const tenants = await res.json();
      return new Response(JSON.stringify({ tenants }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Permet à l'admin d'ouvrir, en un clic depuis son propre tableau de
    // bord, le portail exact d'un propriétaire/locataire/prospecteur téléphonique —
    // sans connaître son mot de passe. Génère un lien magique Supabase à
    // usage unique (redirige vers le bon portail avec une session déjà
    // ouverte pour ce compte) plutôt qu'une vraie connexion : le mot de
    // passe du client n'est jamais consulté ni modifié. Chaque génération
    // est consignée à l'audit, avant même que le lien soit utilisé.
    // Crée en un clic un compte de démonstration pour chacun des 4 rôles
    // (propriétaire, locataire, prospecteur téléphonique, travailleur) sur un immeuble/
    // unité fictifs partagés — pour accéder à chaque portail directement
    // avec un vrai mot de passe permanent, sans repasser par tous les
    // formulaires d'onboarding un par un à chaque fois. Idempotent : repéré
    // par courriel fixe (demo-*@portailgestion.ca) — si le compte existe
    // déjà, son mot de passe est simplement régénéré plutôt que d'en créer
    // un doublon.
    if (action === "seed_demo_accounts") {
      const upsertAuthUser = async (email: string, roleOverride?: string) => {
        const password = randomPassword();
        const existingRes = await fetch(`${supabaseUrl}/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=id`, { headers: adminHeaders });
        const [existingUser] = await existingRes.json().catch(() => [null]);
        if (existingUser) {
          await fetch(`${supabaseUrl}/auth/v1/admin/users/${existingUser.id}`, {
            method: "PUT", headers: adminHeaders, body: JSON.stringify({ password, email_confirm: true }),
          });
          return { id: existingUser.id, password };
        }
        const authRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
          method: "POST", headers: adminHeaders,
          body: JSON.stringify({ email, password, email_confirm: true }),
        });
        const authData = await authRes.json();
        if (!authRes.ok || !authData.id) {
          throw new Error(authData.msg || authData.error_description || `Impossible de créer ${email}`);
        }
        if (roleOverride) {
          await fetch(`${supabaseUrl}/rest/v1/users?id=eq.${authData.id}`, {
            method: "PATCH", headers: adminHeaders, body: JSON.stringify({ role: roleOverride }),
          });
        }
        return { id: authData.id, password };
      };

      try {
        const DEMO_ZONE = "Démo";

        const ownerAuth = await upsertAuthUser("demo-proprietaire@portailgestion.ca");
        const ownerRowRes = await fetch(`${supabaseUrl}/rest/v1/owners?user_id=eq.${ownerAuth.id}&select=id`, { headers: adminHeaders });
        let [owner] = await ownerRowRes.json().catch(() => [null]);
        if (!owner) {
          const insertRes = await fetch(`${supabaseUrl}/rest/v1/owners`, {
            method: "POST", headers: { ...adminHeaders, Prefer: "return=representation" },
            body: JSON.stringify({ user_id: ownerAuth.id, full_name: "Propriétaire Démo", company_name: "Démo Immobilier", management_rate: 6.0, spending_cap: 300 }),
          });
          [owner] = await insertRes.json();
        }

        const buildingRowRes = await fetch(`${supabaseUrl}/rest/v1/buildings?owner_id=eq.${owner.id}&select=id`, { headers: adminHeaders });
        let [building] = await buildingRowRes.json().catch(() => [null]);
        if (!building) {
          const insertRes = await fetch(`${supabaseUrl}/rest/v1/buildings`, {
            method: "POST", headers: { ...adminHeaders, Prefer: "return=representation" },
            body: JSON.stringify({ owner_id: owner.id, address: "123 Rue Démo, Québec", unit_count: 1, zone: DEMO_ZONE }),
          });
          [building] = await insertRes.json();
        } else {
          await fetch(`${supabaseUrl}/rest/v1/buildings?id=eq.${building.id}`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ zone: DEMO_ZONE }) });
        }

        const unitRowRes = await fetch(`${supabaseUrl}/rest/v1/units?building_id=eq.${building.id}&select=id`, { headers: adminHeaders });
        let [unit] = await unitRowRes.json().catch(() => [null]);
        if (!unit) {
          const insertRes = await fetch(`${supabaseUrl}/rest/v1/units`, {
            method: "POST", headers: { ...adminHeaders, Prefer: "return=representation" },
            body: JSON.stringify({ building_id: building.id, unit_number: "1", unit_type: "4 1/2", rent: 900, status: "occupied" }),
          });
          [unit] = await insertRes.json();
        }

        const tenantAuth = await upsertAuthUser("demo-locataire@portailgestion.ca", "tenant");
        const tenantRowRes = await fetch(`${supabaseUrl}/rest/v1/tenants?user_id=eq.${tenantAuth.id}&select=id`, { headers: adminHeaders });
        const [existingTenant] = await tenantRowRes.json().catch(() => [null]);
        if (!existingTenant) {
          const insertRes = await fetch(`${supabaseUrl}/rest/v1/tenants`, {
            method: "POST", headers: { ...adminHeaders, Prefer: "return=representation" },
            body: JSON.stringify({ user_id: tenantAuth.id, full_name: "Locataire Démo", email: "demo-locataire@portailgestion.ca" }),
          });
          const [newTenant] = await insertRes.json();
          await fetch(`${supabaseUrl}/rest/v1/leases`, {
            method: "POST", headers: adminHeaders,
            body: JSON.stringify({ unit_id: unit.id, tenant_id: newTenant.id, start_date: new Date().toISOString().slice(0, 10), monthly_rent: 900, status: "active" }),
          });
        }

        const callerAuth = await upsertAuthUser("demo-cold-caller@portailgestion.ca", "caller");
        const callerRowRes = await fetch(`${supabaseUrl}/rest/v1/cold_callers?user_id=eq.${callerAuth.id}&select=id`, { headers: adminHeaders });
        const [existingCaller] = await callerRowRes.json().catch(() => [null]);
        if (!existingCaller) {
          await fetch(`${supabaseUrl}/rest/v1/cold_callers`, {
            method: "POST", headers: adminHeaders,
            body: JSON.stringify({ user_id: callerAuth.id, full_name: "Prospecteur Démo", email: "demo-cold-caller@portailgestion.ca" }),
          });
        }

        // Créé directement par un admin (pas une auto-inscription publique
        // via pro.html) donc auto-vérifié — sinon aucun mandat ne lui
        // serait jamais envoyé par le moteur de dispatch.
        const workerAuth = await upsertAuthUser("demo-travailleur@portailgestion.ca", "worker");
        const workerRowRes = await fetch(`${supabaseUrl}/rest/v1/workers?user_id=eq.${workerAuth.id}&select=id`, { headers: adminHeaders });
        const [existingWorker] = await workerRowRes.json().catch(() => [null]);
        if (!existingWorker) {
          await fetch(`${supabaseUrl}/rest/v1/workers`, {
            method: "POST", headers: adminHeaders,
            body: JSON.stringify({
              user_id: workerAuth.id, name: "Travailleur Démo", email: "demo-travailleur@portailgestion.ca",
              specialties: ["plomberie", "electricite", "serrurerie", "cvac"], zones: [DEMO_ZONE],
              hourly_rate: 65, handles_urgent: true, verification_status: "verified",
              verified_at: new Date().toISOString(), verified_by: userId, availability_status: "maintenant",
            }),
          });
        } else {
          await fetch(`${supabaseUrl}/rest/v1/workers?id=eq.${existingWorker.id}`, {
            method: "PATCH", headers: adminHeaders, body: JSON.stringify({ zones: [DEMO_ZONE], verification_status: "verified" }),
          });
        }

        await logAudit("admin.seed_demo_accounts", "users", null, {
          emails: ["demo-proprietaire@portailgestion.ca", "demo-locataire@portailgestion.ca", "demo-cold-caller@portailgestion.ca", "demo-travailleur@portailgestion.ca"],
        });

        return new Response(JSON.stringify({
          ok: true,
          accounts: [
            { role: "Propriétaire", email: "demo-proprietaire@portailgestion.ca", temp_password: ownerAuth.password, portal_url: OWNER_PORTAL_URL },
            { role: "Locataire", email: "demo-locataire@portailgestion.ca", temp_password: tenantAuth.password, portal_url: TENANT_PORTAL_URL },
            { role: "Prospecteur téléphonique", email: "demo-cold-caller@portailgestion.ca", temp_password: callerAuth.password, portal_url: CALLER_PORTAL_URL },
            { role: "Travailleur", email: "demo-travailleur@portailgestion.ca", temp_password: workerAuth.password, portal_url: WORKER_PORTAL_URL },
          ],
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: corsHeaders });
      }
    }

    if (action === "impersonate_user") {
      const { target_role, target_id } = body;
      // nameColumn : "workers" utilise "name", pas "full_name" comme les
      // autres tables — sans ça, PostgREST renvoie une erreur 400 en
      // sélectionnant une colonne qui n'existe pas sur "workers".
      const roleConfig: Record<string, { table: string; portalUrl: string; nameColumn: string }> = {
        owner: { table: "owners", portalUrl: OWNER_PORTAL_URL, nameColumn: "full_name" },
        tenant: { table: "tenants", portalUrl: TENANT_PORTAL_URL, nameColumn: "full_name" },
        caller: { table: "cold_callers", portalUrl: CALLER_PORTAL_URL, nameColumn: "full_name" },
        worker: { table: "workers", portalUrl: WORKER_PORTAL_URL, nameColumn: "name" },
      };
      const config = roleConfig[target_role];
      if (!config || !target_id) {
        return new Response(JSON.stringify({ error: "target_role ou target_id invalide" }), { status: 400, headers: corsHeaders });
      }

      const targetRes = await fetch(`${supabaseUrl}/rest/v1/${config.table}?id=eq.${target_id}&select=id,user_id,${config.nameColumn}`, { headers: adminHeaders });
      const [target] = await targetRes.json().catch(() => [null]);
      if (!target) {
        return new Response(JSON.stringify({ error: "Compte introuvable" }), { status: 404, headers: corsHeaders });
      }
      if (!target.user_id) {
        return new Response(JSON.stringify({ error: "Ce compte n'a pas encore d'accès portail créé" }), { status: 400, headers: corsHeaders });
      }

      const userRowRes = await fetch(`${supabaseUrl}/rest/v1/users?id=eq.${target.user_id}&select=email`, { headers: adminHeaders });
      const [userRow] = await userRowRes.json().catch(() => [null]);
      if (!userRow?.email) {
        return new Response(JSON.stringify({ error: "Courriel introuvable pour ce compte" }), { status: 404, headers: corsHeaders });
      }

      const linkRes = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ type: "magiclink", email: userRow.email, options: { redirect_to: config.portalUrl } }),
      });
      const linkData = await linkRes.json();
      const actionLink = linkData?.action_link || linkData?.properties?.action_link;
      if (!linkRes.ok || !actionLink) {
        return new Response(JSON.stringify({ error: linkData?.msg || linkData?.error_description || "Impossible de générer le lien d'accès" }), { status: 400, headers: corsHeaders });
      }

      await logAudit("admin.impersonate", config.table, target_id, { target_role, target_email: userRow.email, target_name: target[config.nameColumn] });
      return new Response(JSON.stringify({ ok: true, action_link: actionLink }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
