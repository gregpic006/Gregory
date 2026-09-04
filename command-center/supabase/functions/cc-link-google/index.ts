// =====================================================================
// cc-link-google — rattache un compte Google au Command Center
//
// Appelée juste après la connexion « Continuer avec Google ». Le
// navigateur reçoit de Supabase un provider_refresh_token ; il le
// transmet ici IMMÉDIATEMENT et ne le garde pas. Ce jeton est ensuite
// chiffré et rangé dans google_accounts, table verrouillée au
// service_role : plus personne, pas même un admin connecté, ne peut le
// relire depuis le navigateur.
//
// C'est ce seul aller-retour qui fait qu'un clic sur « Continuer avec
// Google » suffit à la fois pour ouvrir une session ET pour donner au
// Command Center l'accès courriel/agenda/documents — sans deuxième
// écran de configuration.
// =====================================================================

import {
  corsHeadersFor, json, requireMember, db, dbWrite,
  encryptToken, logActivity,
} from "../_shared/cc.ts";

// Sans ces trois autorisations, la moitié du produit ne fonctionne pas.
// On les vérifie à la connexion plutôt que de laisser la synchronisation
// échouer silencieusement une heure plus tard.
const REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive.readonly",
];

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  try {
    const auth = await requireMember(req);
    if (!auth.ok) return json({ error: auth.error }, auth.status, cors);
    const { member } = auth;

    const body = await req.json().catch(() => ({}));
    const refreshToken: string | undefined = body.provider_refresh_token;
    const googleEmail: string | undefined = (body.google_email ?? "").toLowerCase().trim();
    const scopes: string[] = typeof body.scope === "string" ? body.scope.split(/\s+/) : (body.scopes ?? []);

    if (!googleEmail) return json({ error: "Adresse Google manquante." }, 400, cors);

    const existing = await db<{ id: string; member_id: string; refresh_token_enc: string | null }>(
      `google_accounts?google_email=eq.${encodeURIComponent(googleEmail)}&select=id,member_id,refresh_token_enc`,
    );

    // Google ne renvoie un refresh_token qu'à la PREMIÈRE autorisation
    // (ou avec prompt=consent). Aux connexions suivantes il est absent :
    // ce n'est pas une erreur, il faut juste garder celui déjà stocké.
    if (!refreshToken && !existing.length) {
      return json({
        error: "Google n'a pas fourni d'autorisation durable.",
        hint: "Déconnecte l'accès dans ton compte Google (Sécurité → Applications tierces), puis reconnecte-toi.",
        needs_reconsent: true,
      }, 400, cors);
    }

    if (existing.length && existing[0].member_id !== member.id) {
      return json({
        error: `L'adresse ${googleEmail} est déjà rattachée à un autre membre de l'équipe.`,
      }, 409, cors);
    }

    const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));

    const payload: Record<string, unknown> = {
      member_id: member.id,
      google_email: googleEmail,
      granted_scopes: scopes,
      status: missing.length ? "needs_reauth" : "active",
      last_error: missing.length ? `Autorisations manquantes : ${missing.join(", ")}` : null,
    };
    if (refreshToken) payload.refresh_token_enc = await encryptToken(refreshToken);

    let accountId: string;
    if (existing.length) {
      await dbWrite(`google_accounts?id=eq.${existing[0].id}`, "PATCH", payload, "return=minimal");
      accountId = existing[0].id;
    } else {
      const [row] = await dbWrite<{ id: string }>("google_accounts", "POST", payload);
      accountId = row.id;
      // Un compte fraîchement connecté n'a aucun curseur : la première
      // passe de synchronisation partira de zéro (14 derniers jours).
      await dbWrite("sync_state", "POST", [
        { google_account_id: accountId, source: "gmail" },
        { google_account_id: accountId, source: "calendar" },
        { google_account_id: accountId, source: "drive" },
      ], "return=minimal");
    }

    await logActivity({
      entity_type: "google_account", entity_id: accountId, actor_kind: "human",
      member_id: member.id, action: "google_connected",
      summary: `${member.full_name} a connecté ${googleEmail}.`,
      details: { scopes_missing: missing },
    });

    return json({
      ok: true,
      account_id: accountId,
      google_email: googleEmail,
      missing_scopes: missing,
      warning: missing.length
        ? "Certaines autorisations n'ont pas été accordées — courriels, agenda ou documents resteront vides."
        : null,
    }, 200, cors);
  } catch (err) {
    return json({ error: String(err) }, 500, cors);
  }
});
