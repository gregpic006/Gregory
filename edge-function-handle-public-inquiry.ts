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

const RATE_LIMIT_PER_HOUR = 5;
const MESSAGE_MAX_LENGTH = 2000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const {
      type, unit_id, full_name, email, phone, message, website, consent,
      sector, num_doors, avg_rent, ownership, current_management,
      services_needed, main_problem, desired_start_date, best_call_time,
    } = body;

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

    // Preuve de consentement horodatée (Loi 25) — le consentement était
    // vérifié ci-dessus mais jamais conservé après coup. La finalité est
    // déjà scopée à cette seule demande (visite ou évaluation), pas un
    // consentement générique à du démarchage futur.
    const insertPayload: Record<string, unknown> = {
      type,
      full_name: String(full_name).trim().slice(0, 200),
      email: String(email).trim().slice(0, 200),
      phone: phone ? String(phone).trim().slice(0, 40) : null,
      message: message ? String(message).trim().slice(0, MESSAGE_MAX_LENGTH) : null,
      consented_at: new Date().toISOString(),
      consent_purpose: type === "visite" ? "Être contacté au sujet de cette demande de visite" : "Être contacté au sujet de cette demande d'évaluation",
    };
    if (type === "visite" && unit_id) insertPayload.unit_id = unit_id;

    if (type === "mandat") {
      if (sector) insertPayload.sector = String(sector).trim().slice(0, 300);
      if (num_doors != null && Number.isFinite(Number(num_doors))) insertPayload.num_doors = Math.max(0, Math.round(Number(num_doors)));
      if (avg_rent != null && Number.isFinite(Number(avg_rent))) insertPayload.avg_rent = Math.max(0, Number(avg_rent));
      if (["personnel", "societe"].includes(ownership)) insertPayload.ownership = ownership;
      if (["autogere", "sous_gestion"].includes(current_management)) insertPayload.current_management = current_management;
      if (services_needed) insertPayload.services_needed = String(services_needed).trim().slice(0, 300);
      if (main_problem) insertPayload.main_problem = String(main_problem).trim().slice(0, 300);
      if (desired_start_date) insertPayload.desired_start_date = desired_start_date;
      if (best_call_time) insertPayload.best_call_time = String(best_call_time).trim().slice(0, 100);
    }

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
