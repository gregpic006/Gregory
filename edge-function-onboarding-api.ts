const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const OWNER_PORTAL_URL = "https://gregpic006.github.io/Gregory/portail-proprietaire.html";
const TENANT_PORTAL_URL = "https://gregpic006.github.io/Gregory/portail-locataire.html";

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
      return new Response(JSON.stringify({ ok: true, owner_id: owner?.id }), { status: 200, headers: corsHeaders });
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
      if (!full_name || !email || !unit_id || !monthly_rent || !start_date) {
        return new Response(JSON.stringify({ error: "Champs manquants (nom, courriel, unité, loyer, date de début)" }), { status: 400, headers: corsHeaders });
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

      // Le déclencheur d'inscription met "owner" par défaut — on corrige pour "tenant".
      await fetch(`${supabaseUrl}/rest/v1/users?id=eq.${authData.id}`, {
        method: "PATCH", headers: adminHeaders, body: JSON.stringify({ role: "tenant" }),
      });

      const tenantRes = await fetch(`${supabaseUrl}/rest/v1/tenants`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "return=representation" },
        body: JSON.stringify({ user_id: authData.id, full_name, email, phone: phone || null }),
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

      await sendEmail(email, "Bienvenue sur Portail — ton accès locataire",
        `Bonjour ${full_name},\n\nTon compte locataire Portail est prêt.\n\nPortail : ${TENANT_PORTAL_URL}\nCourriel : ${email}\nMot de passe temporaire : ${password}\n\nConnecte-toi pour voir ton bail, tes paiements et faire une demande de service. Tu peux changer ton mot de passe via "Mot de passe oublié" sur la page de connexion.\n\nL'équipe Portail`);

      await logAudit("tenant.create", "tenants", tenant?.id ?? null, { email, unit_id });
      return new Response(JSON.stringify({ ok: true, tenant_id: tenant?.id }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
