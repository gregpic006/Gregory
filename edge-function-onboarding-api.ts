const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const OWNER_PORTAL_URL = "https://portailgestion.ca/portail-proprietaire.html";
const TENANT_PORTAL_URL = "https://portailgestion.ca/portail-locataire.html";

function randomPassword() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 14);
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
        body: JSON.stringify({ from: "Portail <onboarding@resend.dev>", to: [to], subject, text }),
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

    if (action === "find_owner_by_email") {
      const res = await fetch(`${supabaseUrl}/rest/v1/users?email=eq.${encodeURIComponent(body.email)}&role=eq.owner&select=id`, { headers: adminHeaders });
      const [userRow] = await res.json();
      if (!userRow) return new Response(JSON.stringify({ owner: null }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const ownerRes = await fetch(`${supabaseUrl}/rest/v1/owners?user_id=eq.${userRow.id}&select=id,full_name`, { headers: adminHeaders });
      const [owner] = await ownerRes.json();
      return new Response(JSON.stringify({ owner: owner || null }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
      return new Response(JSON.stringify({ ok: true, owner_id: owner?.id, temp_password: password }), { status: 200, headers: corsHeaders });
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
      return new Response(JSON.stringify({ ok: true, building_id: building?.id }), { status: 200, headers: corsHeaders });
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
      return new Response(JSON.stringify({ ok: true, unit_id: unit?.id }), { status: 200, headers: corsHeaders });
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
      return new Response(JSON.stringify({ ok: true, tenant_id: tenant?.id, temp_password: tempPassword }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
