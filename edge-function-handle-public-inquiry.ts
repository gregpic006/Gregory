const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RATE_LIMIT_PER_HOUR = 5;
const MESSAGE_MAX_LENGTH = 2000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const { type, unit_id, full_name, email, phone, message, website, consent } = body;

    // Honeypot : un bot remplit ce champ invisible, un humain ne le voit jamais.
    if (website) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (!["visite", "mandat"].includes(type)) {
      return new Response(JSON.stringify({ error: "Type de demande invalide" }), { status: 400, headers: corsHeaders });
    }
    if (!full_name || String(full_name).trim().length < 2 || String(full_name).length > 200) {
      return new Response(JSON.stringify({ error: "Nom invalide" }), { status: 400, headers: corsHeaders });
    }
    if (!email || !EMAIL_RE.test(String(email)) || String(email).length > 200) {
      return new Response(JSON.stringify({ error: "Courriel invalide" }), { status: 400, headers: corsHeaders });
    }
    if (phone && String(phone).length > 40) {
      return new Response(JSON.stringify({ error: "Téléphone invalide" }), { status: 400, headers: corsHeaders });
    }
    if (message && String(message).length > MESSAGE_MAX_LENGTH) {
      return new Response(JSON.stringify({ error: "Message trop long" }), { status: 400, headers: corsHeaders });
    }
    if (!consent) {
      return new Response(JSON.stringify({ error: "Le consentement est requis" }), { status: 400, headers: corsHeaders });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    if (type === "visite") {
      if (!unit_id) {
        return new Response(JSON.stringify({ error: "Unité manquante" }), { status: 400, headers: corsHeaders });
      }
      const unitRes = await fetch(
        `${supabaseUrl}/rest/v1/units?id=eq.${unit_id}&status=in.(available,soon_available)&select=id`,
        { headers: adminHeaders },
      );
      const units = await unitRes.json();
      if (!units.length) {
        return new Response(JSON.stringify({ error: "Ce logement n'est plus disponible" }), { status: 400, headers: corsHeaders });
      }
    }

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const rateRes = await fetch(
      `${supabaseUrl}/rest/v1/public_submission_log?ip_address=eq.${encodeURIComponent(ip)}&created_at=gte.${oneHourAgo}&select=id`,
      { headers: adminHeaders },
    );
    const recent = await rateRes.json();
    if (recent.length >= RATE_LIMIT_PER_HOUR) {
      return new Response(JSON.stringify({ error: "Trop de demandes envoyées récemment — réessaie plus tard." }), { status: 429, headers: corsHeaders });
    }

    await fetch(`${supabaseUrl}/rest/v1/public_submission_log`, {
      method: "POST", headers: adminHeaders, body: JSON.stringify({ ip_address: ip }),
    });

    const insertPayload: Record<string, unknown> = {
      type,
      full_name: String(full_name).trim().slice(0, 200),
      email: String(email).trim().slice(0, 200),
      phone: phone ? String(phone).trim().slice(0, 40) : null,
      message: message ? String(message).trim().slice(0, MESSAGE_MAX_LENGTH) : null,
    };
    if (type === "visite" && unit_id) insertPayload.unit_id = unit_id;

    const insertRes = await fetch(`${supabaseUrl}/rest/v1/inquiries`, {
      method: "POST", headers: adminHeaders, body: JSON.stringify(insertPayload),
    });
    if (!insertRes.ok) {
      return new Response(JSON.stringify({ error: "Une erreur est survenue, réessaie dans un instant." }), { status: 500, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
