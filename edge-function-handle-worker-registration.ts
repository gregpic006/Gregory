// Fonction PUBLIQUE (pas de JWT) — inscription "Portail Pro" depuis pro.html.
// Même discipline anti-spam que handle-public-inquiry.ts : honeypot,
// limite de débit par IP (public_submission_log), validation stricte.
// Crée directement un compte (le travailleur peut se connecter tout de
// suite et compléter son profil) mais avec verification_status='pending'
// — aucun mandat ne lui sera envoyé tant qu'un admin n'a pas vérifié son
// dossier (voir dispatch-work-order.ts, qui ne considère que
// verification_status='verified').
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

const WORKER_PORTAL_URL = "https://portailgestion.ca/portail-travailleur.html";
const RATE_LIMIT_PER_HOUR = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_SPECIALTIES = ["plomberie", "electricite", "cvac", "serrurerie", "structure", "peinture", "menage", "autre"];

function randomPassword() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 14);
}

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const {
      full_name, company_name, email, phone, neq, specialties, zones,
      hourly_rate, handles_urgent, rbq_license, website, consent,
    } = body;

    // Honeypot : un bot remplit ce champ invisible, un humain ne le voit jamais.
    if (website) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (!full_name || String(full_name).trim().length < 2 || String(full_name).length > 200) {
      return new Response(JSON.stringify({ error: "Nom invalide" }), { status: 400, headers: corsHeaders });
    }
    if (!email || !EMAIL_RE.test(String(email)) || String(email).length > 200) {
      return new Response(JSON.stringify({ error: "Courriel invalide" }), { status: 400, headers: corsHeaders });
    }
    if (!Array.isArray(specialties) || !specialties.length || !specialties.every((s: string) => ALLOWED_SPECIALTIES.includes(s))) {
      return new Response(JSON.stringify({ error: "Sélectionne au moins un métier valide" }), { status: 400, headers: corsHeaders });
    }
    if (!Array.isArray(zones) || !zones.length) {
      return new Response(JSON.stringify({ error: "Indique au moins une zone desservie" }), { status: 400, headers: corsHeaders });
    }
    if (!consent) {
      return new Response(JSON.stringify({ error: "Le consentement est requis" }), { status: 400, headers: corsHeaders });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const rateRes = await fetch(
      `${supabaseUrl}/rest/v1/public_submission_log?ip_address=eq.${encodeURIComponent(ip)}&created_at=gte.${oneHourAgo}&select=id`,
      { headers: adminHeaders },
    );
    const recent = await rateRes.json().catch(() => []);
    if (Array.isArray(recent) && recent.length >= RATE_LIMIT_PER_HOUR) {
      return new Response(JSON.stringify({ error: "Trop de demandes envoyées récemment — réessaie plus tard." }), { status: 429, headers: corsHeaders });
    }
    await fetch(`${supabaseUrl}/rest/v1/public_submission_log`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ ip_address: ip }) });

    const existingRes = await fetch(`${supabaseUrl}/rest/v1/users?email=eq.${encodeURIComponent(String(email))}&select=id`, { headers: adminHeaders });
    const existing = await existingRes.json().catch(() => []);
    if (Array.isArray(existing) && existing.length) {
      return new Response(JSON.stringify({ error: "Un compte existe déjà avec ce courriel." }), { status: 400, headers: corsHeaders });
    }

    const password = randomPassword();
    const authRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: "POST", headers: adminHeaders,
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    const authData = await authRes.json();
    if (!authRes.ok || !authData.id) {
      return new Response(JSON.stringify({ error: authData.msg || authData.error_description || "Impossible de créer le compte" }), { status: 400, headers: corsHeaders });
    }

    // Le déclencheur d'inscription met "owner" par défaut — on corrige pour "worker".
    await fetch(`${supabaseUrl}/rest/v1/users?id=eq.${authData.id}`, {
      method: "PATCH", headers: adminHeaders, body: JSON.stringify({ role: "worker" }),
    });

    const workerRes = await fetch(`${supabaseUrl}/rest/v1/workers`, {
      method: "POST",
      headers: { ...adminHeaders, Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: authData.id,
        name: String(full_name).trim().slice(0, 200),
        company_name: company_name ? String(company_name).trim().slice(0, 200) : null,
        email: String(email).trim().slice(0, 200),
        phone: phone ? String(phone).trim().slice(0, 40) : null,
        neq: neq ? String(neq).trim().slice(0, 50) : null,
        specialties,
        zones: zones.map((z: string) => String(z).trim().slice(0, 100)).slice(0, 20),
        hourly_rate: hourly_rate != null && Number.isFinite(Number(hourly_rate)) ? Number(hourly_rate) : null,
        handles_urgent: !!handles_urgent,
        rbq_license: rbq_license ? String(rbq_license).trim().slice(0, 50) : null,
        verification_status: "pending",
      }),
    });
    const [worker] = await workerRes.json().catch(() => [null]);

    let emailSent = true;
    let emailError: string | null = null;
    try {
      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Portail <onboarding@mail.portailgestion.ca>",
          to: [email],
          subject: "Bienvenue sur Portail Pro — ton dossier est en cours de vérification",
          text: `Bonjour ${full_name},\n\nMerci de t'être inscrit sur Portail Pro. Ton compte est prêt et ton dossier est maintenant en attente de vérification par notre équipe (licence, assurance) — tu recevras des mandats dès qu'il sera approuvé.\n\nPortail : ${WORKER_PORTAL_URL}\nCourriel : ${email}\nMot de passe temporaire : ${password}\n\nConnecte-toi pour compléter ton profil (horaire, assurance, photos) en attendant. Tu peux changer ton mot de passe via "Mot de passe oublié" sur la page de connexion.\n\nL'équipe Portail`,
        }),
      });
      const emailData = await emailRes.json().catch(() => ({}));
      if (!emailRes.ok) { emailSent = false; emailError = emailData?.message || "Échec de l'envoi du courriel"; }
    } catch (e) {
      emailSent = false;
      emailError = String(e);
    }

    try {
      const adminsRes = await fetch(`${supabaseUrl}/rest/v1/users?is_admin=eq.true&select=email`, { headers: adminHeaders });
      const admins = await adminsRes.json().catch(() => []);
      const adminEmails = Array.isArray(admins) ? admins.map((a: any) => a.email).filter(Boolean) : [];
      if (adminEmails.length && resendKey) {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "Portail <onboarding@mail.portailgestion.ca>",
            to: adminEmails,
            subject: `Nouvelle inscription Portail Pro — ${full_name}`,
            text: `${full_name}${company_name ? " (" + company_name + ")" : ""} vient de s'inscrire sur Portail Pro.\n\nMétiers : ${specialties.join(", ")}\nZones : ${zones.join(", ")}\nCourriel : ${email}\nTéléphone : ${phone || "non fourni"}\n\nSon dossier attend une vérification dans le portail admin avant de recevoir des mandats.`,
          }),
        });
      }
    } catch (e) {
      console.error("Failed to notify admins of new worker registration", e);
    }

    await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
      method: "POST", headers: adminHeaders,
      body: JSON.stringify({ actor_type: "system", action: "worker.self_registered", entity_type: "workers", entity_id: worker?.id ?? null, details: { email, specialties, zones } }),
    });

    return new Response(JSON.stringify({ ok: true, email_sent: emailSent, email_error: emailError }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
