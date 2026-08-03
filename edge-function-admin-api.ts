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
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const userRes = await fetch(`${supabaseUrl}/rest/v1/users?id=eq.${userId}&select=is_admin`, {
      headers: adminHeaders,
    });
    const userRows = await userRes.json();
    if (!userRows?.[0]?.is_admin) {
      return new Response(JSON.stringify({ error: "Accès refusé — compte non admin" }), { status: 403, headers: corsHeaders });
    }

    const body = await req.json().catch(() => ({}));

    if (body.action === "update_anomaly") {
      const { anomaly_id, status } = body;
      await fetch(`${supabaseUrl}/rest/v1/financial_anomalies?id=eq.${anomaly_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ status }),
      });
      await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ actor_type: "admin", actor_id: userId, action: "anomaly.update", entity_type: "financial_anomalies", entity_id: anomaly_id, details: { new_status: status } }),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    const ownersRes = await fetch(
      `${supabaseUrl}/rest/v1/owners?select=id,full_name,phone,management_rate,spending_cap,buildings(id,address,units(id,rent,status))`,
      { headers: adminHeaders },
    );
    const owners = await ownersRes.json();

    const approvalsRes = await fetch(
      `${supabaseUrl}/rest/v1/approvals?status=eq.pending&select=id`,
      { headers: adminHeaders },
    );
    const pendingApprovals = await approvalsRes.json();

    const inquiriesRes = await fetch(
      `${supabaseUrl}/rest/v1/inquiries?status=eq.new&select=id`,
      { headers: adminHeaders },
    );
    const newInquiries = await inquiriesRes.json();

    const anomaliesRes = await fetch(
      `${supabaseUrl}/rest/v1/financial_anomalies?status=eq.open&select=*,owners(full_name)&order=severity.asc,created_at.desc`,
      { headers: adminHeaders },
    );
    const anomalies = await anomaliesRes.json();

    const clients = owners.map((o: any) => {
      const buildings = o.buildings || [];
      const units = buildings.flatMap((b: any) => b.units || []);
      const occupied = units.filter((u: any) => u.status === "occupied").length;
      const monthlyRevenue = units.reduce((sum: number, u: any) => sum + (Number(u.rent) || 0), 0) * (Number(o.management_rate) / 100);
      return {
        id: o.id,
        full_name: o.full_name,
        phone: o.phone,
        buildings_count: buildings.length,
        units_count: units.length,
        occupied_count: occupied,
        monthly_revenue: Math.round(monthlyRevenue * 100) / 100,
      };
    });

    const totals = {
      clients_count: clients.length,
      buildings_count: clients.reduce((s: number, c: any) => s + c.buildings_count, 0),
      units_count: clients.reduce((s: number, c: any) => s + c.units_count, 0),
      monthly_revenue: Math.round(clients.reduce((s: number, c: any) => s + c.monthly_revenue, 0) * 100) / 100,
      pending_approvals: pendingApprovals.length,
      new_inquiries: newInquiries.length,
      open_anomalies: anomalies.length,
    };

    return new Response(JSON.stringify({ totals, clients, anomalies }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
