// Portail des prospecteurs téléphoniques (travailleurs autonomes de prospection
// téléphonique). Contrairement à crm-api.ts (réservé aux admins), cette
// fonction sert un compte "caller" — mais elle n'ouvre AUCUNE policy RLS
// sur prospects (qui reste verrouillée au rôle service_role, voir
// schema.sql). Chaque action ici vérifie explicitement que le prospect
// visé est bien assigné à l'appelant connecté avant d'y toucher, exactement
// comme crm-api.ts le fait pour l'admin — la même donnée sensible, gardée
// par la même discipline, juste un périmètre plus étroit.
//
// Un prospecteur téléphonique ne peut PAS marquer un dossier "lost", ni modifier le coût
// d'acquisition — ces décisions restent à l'admin via crm-api.ts. Via
// update_my_stage, il peut seulement faire progresser un prospect de 'new'
// à 'contacted' ou 'interested'. La seule façon d'atteindre 'signed' est
// l'action create_client (conversion réelle en client), qui crée le compte
// propriétaire lui-même — pas une simple mise à jour de statut.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CALLER_ALLOWED_STAGES = ["contacted", "interested"];
const OWNER_PORTAL_URL = "https://portailgestion.ca/portail-proprietaire.html";

function randomPassword() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 14);
}

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
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const callerRes = await fetch(`${supabaseUrl}/rest/v1/cold_callers?user_id=eq.${userId}&select=id,full_name,active`, { headers: adminHeaders });
    const [caller] = await callerRes.json().catch(() => [null]);
    if (!caller || !caller.active) {
      return new Response(JSON.stringify({ error: "Accès refusé — compte de prospecteur téléphonique introuvable ou désactivé" }), { status: 403, headers: corsHeaders });
    }
    const callerId = caller.id;

    const logAudit = (action: string, entityType: string, entityId: string | null, details: Record<string, unknown>) =>
      fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ actor_type: "caller", actor_id: userId, action, entity_type: entityType, entity_id: entityId, details }),
      });

    const sendEmail = (to: string, subject: string, text: string) =>
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: "Portail <onboarding@mail.portailgestion.ca>", to: [to], subject, text }),
      });

    const body = await req.json().catch(() => ({}));
    const action = body.action || "list_my_prospects";

    if (action === "list_my_prospects") {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/prospects?assigned_caller_id=eq.${callerId}&select=id,full_name,email,phone,company_name,num_doors,avg_rent,potential_monthly_revenue,stage,interest_level,next_followup_date,call_history,notes,created_at&order=next_followup_date.asc.nullslast`,
        { headers: adminHeaders },
      );
      const prospects = await res.json();
      return new Response(JSON.stringify({ prospects }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "my_stats") {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/prospects?assigned_caller_id=eq.${callerId}&select=stage,call_history,next_followup_date`,
        { headers: adminHeaders },
      );
      const prospects = await res.json();
      const today = new Date().toISOString().slice(0, 10);
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const byStage: Record<string, number> = {};
      let callsToday = 0;
      let callsThisWeek = 0;
      let overdueFollowups = 0;
      for (const p of prospects) {
        byStage[p.stage] = (byStage[p.stage] || 0) + 1;
        if (p.next_followup_date && p.next_followup_date < today) overdueFollowups++;
        const history = Array.isArray(p.call_history) ? p.call_history : [];
        for (const c of history) {
          const day = String(c.date || "").slice(0, 10);
          if (day === today) callsToday++;
          if (day >= weekAgo) callsThisWeek++;
        }
      }
      return new Response(JSON.stringify({
        total_assigned: prospects.length,
        by_stage: byStage,
        calls_today: callsToday,
        calls_this_week: callsThisWeek,
        overdue_followups: overdueFollowups,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "add_call") {
      const { prospect_id, transcript } = body;
      if (!prospect_id || !transcript) {
        return new Response(JSON.stringify({ error: "prospect_id et transcript requis" }), { status: 400, headers: corsHeaders });
      }
      const prospRes = await fetch(`${supabaseUrl}/rest/v1/prospects?id=eq.${prospect_id}&select=*`, { headers: adminHeaders });
      const [prospect] = await prospRes.json();
      if (!prospect) {
        return new Response(JSON.stringify({ error: "Prospect introuvable" }), { status: 404, headers: corsHeaders });
      }
      if (prospect.assigned_caller_id !== callerId) {
        return new Response(JSON.stringify({ error: "Ce prospect ne t'est pas assigné" }), { status: 403, headers: corsHeaders });
      }

      const prompt = `Tu es l'assistant CRM de "Portail". Voici la transcription/notes d'un appel avec un prospect propriétaire. Analyse-la en détail.

Transcription: "${transcript}"

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après):
{
  "summary": "résumé de l'appel en 1-2 phrases en français",
  "key_quotes": ["jusqu'à 2 citations exactes et importantes tirées de la transcription"],
  "objections": "les objections ou réticences exprimées par le prospect, ou null si aucune",
  "commitment": "un engagement concret pris durant l'appel (ex: 'va envoyer les états financiers d'ici vendredi'), ou null si aucun",
  "next_step": "la prochaine étape concrète à faire avec ce prospect, en une phrase",
  "interest_level": "chaud ou tiede ou froid",
  "confidence": un nombre entre 0 et 100 représentant ta confiance dans cette analyse — baisse-la si la transcription est courte, vague ou ambiguë,
  "next_followup_days": un nombre entier de jours avant le prochain suivi recommandé
}`;
      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicKey ?? "",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 500,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const aiData = await aiRes.json();
      const rawText = aiData.content?.[0]?.text ?? "{}";
      const cleaned = rawText.replace(/```json|```/g, "").trim();
      let parsed: any = {};
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        parsed = {};
      }

      const followupDate = parsed.next_followup_days
        ? new Date(Date.now() + parsed.next_followup_days * 86400000).toISOString().slice(0, 10)
        : prospect.next_followup_date;
      const allowedInterestLevels = ["chaud", "tiede", "froid"];
      const interestLevel = allowedInterestLevels.includes(parsed.interest_level) ? parsed.interest_level : null;
      const callHistory = Array.isArray(prospect.call_history) ? prospect.call_history : [];
      // Comme dans crm-api.ts : l'IA ne touche jamais "stage" — seule une
      // action humaine explicite (ici update_my_stage) le peut.
      callHistory.push({
        date: new Date().toISOString(),
        transcript,
        summary: parsed.summary ?? transcript,
        key_quotes: Array.isArray(parsed.key_quotes) ? parsed.key_quotes : [],
        objections: parsed.objections ?? null,
        commitment: parsed.commitment ?? null,
        next_step: parsed.next_step ?? null,
        interest_level: interestLevel,
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
        corrected: false,
        caller_id: callerId,
      });

      await fetch(`${supabaseUrl}/rest/v1/prospects?id=eq.${prospect_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({
          call_history: callHistory,
          interest_level: interestLevel ?? prospect.interest_level,
          next_followup_date: followupDate,
        }),
      });
      await logAudit("prospect.call_logged_by_caller", "prospects", prospect_id, { caller_name: caller.full_name });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "update_my_stage") {
      const { prospect_id, stage } = body;
      if (!prospect_id || !CALLER_ALLOWED_STAGES.includes(stage)) {
        return new Response(JSON.stringify({ error: "Statut invalide pour un prospecteur téléphonique" }), { status: 400, headers: corsHeaders });
      }
      const prospRes = await fetch(`${supabaseUrl}/rest/v1/prospects?id=eq.${prospect_id}&select=assigned_caller_id`, { headers: adminHeaders });
      const [prospect] = await prospRes.json();
      if (!prospect || prospect.assigned_caller_id !== callerId) {
        return new Response(JSON.stringify({ error: "Ce prospect ne t'est pas assigné" }), { status: 403, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/prospects?id=eq.${prospect_id}`, {
        method: "PATCH", headers: adminHeaders, body: JSON.stringify({ stage }),
      });
      await logAudit("prospect.stage_change_by_caller", "prospects", prospect_id, { new_stage: stage, caller_name: caller.full_name });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    // Un prospecteur téléphonique crée lui-même le compte propriétaire quand un
    // prospect accepte de devenir client au téléphone — pas besoin
    // d'attendre l'admin. Si prospect_id est fourni, il doit être assigné
    // à cet appelant ; le prospect passe alors à l'étape "signed" et
    // garde une référence vers le nouveau compte (converted_owner_id).
    if (action === "create_client") {
      const { prospect_id, full_name, email, phone, company_name, management_rate, spending_cap } = body;
      if (!full_name || !email) {
        return new Response(JSON.stringify({ error: "Nom et courriel requis" }), { status: 400, headers: corsHeaders });
      }

      let prospect: any = null;
      if (prospect_id) {
        const prospRes = await fetch(`${supabaseUrl}/rest/v1/prospects?id=eq.${prospect_id}&select=id,assigned_caller_id`, { headers: adminHeaders });
        [prospect] = await prospRes.json();
        if (!prospect) {
          return new Response(JSON.stringify({ error: "Prospect introuvable" }), { status: 404, headers: corsHeaders });
        }
        if (prospect.assigned_caller_id !== callerId) {
          return new Response(JSON.stringify({ error: "Ce prospect ne t'est pas assigné" }), { status: 403, headers: corsHeaders });
        }
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

      let emailSent = true;
      let emailError: string | null = null;
      try {
        const emailRes = await sendEmail(email, "Bienvenue sur Portail — ton accès propriétaire",
          `Bonjour ${full_name},\n\nTon compte propriétaire Portail est prêt.\n\nPortail : ${OWNER_PORTAL_URL}\nCourriel : ${email}\nMot de passe temporaire : ${password}\n\nConnecte-toi puis change ton mot de passe si tu le souhaites (lien "Mot de passe oublié" sur la page de connexion).\n\nL'équipe Portail`);
        const emailData = await emailRes.json().catch(() => ({}));
        if (!emailRes.ok) { emailSent = false; emailError = emailData?.message || "Échec de l'envoi du courriel"; }
      } catch (e) {
        emailSent = false;
        emailError = String(e);
      }

      if (prospect_id) {
        await fetch(`${supabaseUrl}/rest/v1/prospects?id=eq.${prospect_id}`, {
          method: "PATCH",
          headers: adminHeaders,
          body: JSON.stringify({ stage: "signed", converted_owner_id: owner?.id ?? null }),
        });
      }

      await logAudit("owner.create_by_caller", "owners", owner?.id ?? null, { email, prospect_id: prospect_id ?? null, caller_name: caller.full_name });
      return new Response(JSON.stringify({
        ok: true, owner_id: owner?.id, temp_password: password, email_sent: emailSent, email_error: emailError,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
