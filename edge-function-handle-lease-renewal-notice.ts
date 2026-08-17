// Avis de renouvellement/augmentation/non-renouvellement de bail.
// Les dates et délais légaux viennent de lease_renewal_tracking (calcul
// déterministe selon le Code civil du Québec) — jamais de l'IA. Pour
// une augmentation, le montant DOIT être fourni par l'admin (calculé
// selon la méthode réglementaire du TAL, hors de ce système). L'IA se
// limite à rédiger la lettre à partir de faits déjà déterminés, et un
// avertissement légal fixe (non généré par l'IA) est toujours ajouté.
// Le locataire signe désormais lui-même électroniquement via le lien
// envoyé ci-dessous (voir handle-lease-signature.ts / signer-bail.html) —
// décision produit confirmée le 2026-08-14. record_response reste
// disponible pour que l'admin consigne une réponse obtenue autrement
// (ex. verbale), mais n'est plus le chemin principal.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SITE_BASE_URL = "https://portailgestion.ca";

const LEGAL_DISCLAIMER = "Cet avis est transmis à titre informatif dans le cadre de la gestion de votre logement. Il ne remplace pas vos droits prévus au Code civil du Québec : si vous souhaitez refuser une augmentation de loyer ou une modification des conditions du bail, vous devez aviser le propriétaire par écrit dans le délai d'un mois suivant la réception du présent avis, à défaut de quoi vous serez réputé avoir accepté. Pour toute question sur vos droits, vous pouvez consulter le Tribunal administratif du logement (tal.gouv.qc.ca).";

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

    const userRes = await fetch(`${supabaseUrl}/rest/v1/users?id=eq.${userId}&select=is_admin`, { headers: adminHeaders });
    const userRows = await userRes.json();
    if (!userRows?.[0]?.is_admin) {
      return new Response(JSON.stringify({ error: "Accès refusé — compte non admin" }), { status: 403, headers: corsHeaders });
    }

    const logAudit = (action: string, entityId: string | null, details: Record<string, unknown>) =>
      fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ actor_type: "admin", actor_id: userId, action, entity_type: "leases", entity_id: entityId, details }),
      });

    const body = await req.json().catch(() => ({}));
    const action = body.action || "list";

    if (action === "list") {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/lease_renewal_tracking?select=*,leases(tenants(full_name,email),units(unit_number,buildings(address)))&order=end_date.asc`,
        { headers: adminHeaders },
      );
      return new Response(JSON.stringify({ leases: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "send_notice") {
      const { lease_id, notice_type, new_rent_amount, message } = body;
      if (!lease_id || !notice_type) {
        return new Response(JSON.stringify({ error: "lease_id et notice_type requis" }), { status: 400, headers: corsHeaders });
      }
      if (notice_type === "augmentation" && !(Number(new_rent_amount) > 0)) {
        return new Response(JSON.stringify({ error: "new_rent_amount requis et calculé selon la méthode du TAL pour une augmentation — ce système ne le calcule pas automatiquement" }), { status: 400, headers: corsHeaders });
      }

      const leaseRes = await fetch(
        `${supabaseUrl}/rest/v1/leases?id=eq.${lease_id}&select=*,tenants(full_name,email),units(unit_number,buildings(address))`,
        { headers: adminHeaders },
      );
      const [lease] = await leaseRes.json();
      if (!lease) {
        return new Response(JSON.stringify({ error: "Bail introuvable" }), { status: 404, headers: corsHeaders });
      }
      // Un nouveau token de signature est généré à chaque envoi d'avis (y
      // compris un renvoi) : invalide tout lien précédemment transmis.
      const signatureToken = crypto.randomUUID();
      const tenant = lease.tenants;
      if (!tenant?.email) {
        return new Response(JSON.stringify({ error: "Aucun courriel pour ce locataire" }), { status: 400, headers: corsHeaders });
      }

      const factsLabel = notice_type === "augmentation"
        ? `Augmentation du loyer mensuel de ${lease.monthly_rent} $ à ${new_rent_amount} $, à compter du renouvellement du bail (${lease.end_date}).`
        : notice_type === "non_renouvellement"
        ? `Le bail ne sera pas renouvelé à son échéance (${lease.end_date}).`
        : `Renouvellement du bail aux mêmes conditions (loyer inchangé à ${lease.monthly_rent} $), à compter du ${lease.end_date}.`;

      const prompt = `Tu es l'assistant de gestion locative de "Portail", au Québec. Rédige un avis à un locataire à propos de son bail. Utilise UNIQUEMENT les faits fournis ci-dessous — n'invente aucune date, aucun montant, aucune règle légale.

Locataire : ${tenant.full_name}
Adresse : ${lease.units?.buildings?.address || ""} — Unité ${lease.units?.unit_number || ""}
Fin du bail actuel : ${lease.end_date}
Décision : ${factsLabel}
${message ? `Message additionnel du gestionnaire : ${message}` : ""}

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après):
{
  "subject": "objet de courriel court et professionnel en français",
  "body": "corps du courriel en français (4-6 phrases), professionnel et clair, qui communique exactement la décision ci-dessus sans ajouter de détail non fourni. Signé 'L'équipe Portail'."
}`;

      const aiStartedAt = Date.now();
      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": anthropicKey ?? "", "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
      });
      const aiData = await aiRes.json();
      if (!aiRes.ok) {
        console.error("Anthropic API error", aiRes.status, JSON.stringify(aiData));
        await fetch(`${supabaseUrl}/rest/v1/ai_run_log`, {
          method: "POST", headers: adminHeaders,
          body: JSON.stringify({
            function_name: "handle-lease-renewal-notice", trigger_source: "admin_portal", entity_type: "leases", entity_id: lease_id,
            prompt_version: "lease-renewal-notice-v1", model_version: "claude-haiku-4-5-20251001", input_summary: factsLabel,
            duration_ms: Date.now() - aiStartedAt, error: `anthropic_api_error ${aiRes.status}`,
          }),
        }).catch(() => null);
        return new Response(JSON.stringify({ error: "Erreur du service IA" }), { status: 502, headers: corsHeaders });
      }
      const rawText = aiData.content?.[0]?.text ?? "{}";
      const parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());

      await fetch(`${supabaseUrl}/rest/v1/ai_run_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          function_name: "handle-lease-renewal-notice",
          trigger_source: "admin_portal",
          entity_type: "leases",
          entity_id: lease_id,
          prompt_version: "lease-renewal-notice-v1",
          model_version: "claude-haiku-4-5-20251001",
          input_summary: factsLabel,
          output_summary: parsed.subject ?? null,
          duration_ms: Date.now() - aiStartedAt,
          input_tokens: aiData?.usage?.input_tokens ?? null,
          output_tokens: aiData?.usage?.output_tokens ?? null,
          automatic_action_taken: `avis_${notice_type}_envoye`,
        }),
      }).catch((e) => console.error("Failed to write ai_run_log", e));

      // La signature électronique n'a de sens que si le locataire doit
      // manifester son accord (renouvellement, augmentation) — pas pour
      // un non-renouvellement, qui est une simple notification.
      const signatureUrl = `${SITE_BASE_URL}/signer-bail.html?lease=${lease_id}&token=${signatureToken}`;
      const signatureLine = notice_type !== "non_renouvellement"
        ? `\n\nPour confirmer votre accord, signez électroniquement ici : ${signatureUrl}`
        : "";

      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Portail <onboarding@mail.portailgestion.ca>",
          to: [tenant.email],
          subject: parsed.subject,
          text: `${parsed.body}${signatureLine}\n\n---\n${LEGAL_DISCLAIMER}`,
        }),
      });

      await fetch(`${supabaseUrl}/rest/v1/leases?id=eq.${lease_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({
          renewal_notice_sent_at: new Date().toISOString(),
          renewal_notice_type: notice_type,
          renewal_notice_amount: notice_type === "augmentation" ? Number(new_rent_amount) : null,
          renewal_deadline_missed: false,
          renewal_signed: false,
          renewal_signed_at: null,
          renewal_signature_token: notice_type !== "non_renouvellement" ? signatureToken : null,
        }),
      });

      await logAudit("lease_renewal.notice_sent", lease_id, { notice_type, new_rent_amount: new_rent_amount || null });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "record_response") {
      const { lease_id, renewal_response, renewal_signed, renewal_response_note } = body;
      if (!lease_id) {
        return new Response(JSON.stringify({ error: "lease_id manquant" }), { status: 400, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/leases?id=eq.${lease_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({
          renewal_response: renewal_response || undefined,
          renewal_signed: renewal_signed ?? undefined,
          renewal_response_note: renewal_response_note ?? undefined,
        }),
      });
      await logAudit("lease_renewal.response_recorded", lease_id, { renewal_response, renewal_signed, renewal_response_note });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    console.error("handle-lease-renewal-notice unexpected error", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
