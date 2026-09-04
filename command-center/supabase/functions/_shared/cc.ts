// =====================================================================
// LEASE LANE COMMAND CENTER — socle partagé des edge functions
//
// Tout ce qui est utilisé par plus d'une fonction vit ici : CORS,
// vérification du jeton, accès base en service_role, chiffrement des
// jetons Google, appels aux API Google et Anthropic.
//
// Le Portail garde sa convention (helpers dupliqués dans chaque fichier,
// à cause du déploiement par copier-coller). Ici le déploiement est
// automatisé dès le départ, donc un module partagé est possible — et
// préférable : la logique de sécurité n'existe qu'à un seul endroit.
// =====================================================================

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
export const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// D'où le navigateur a le droit d'appeler ces fonctions.
//
// Le Command Center est servi par GitHub Pages, donc depuis le domaine du
// fichier CNAME du dépôt — aujourd'hui portailgestion.ca. Quand Lease Lane
// aura le sien, il n'y aura RIEN à recompiler : il suffit de poser le
// secret d'edge function CC_ALLOWED_ORIGINS (liste séparée par des
// virgules) et de redéployer. Sans ce secret, la valeur par défaut
// ci-dessous s'applique.
const DEFAULT_ORIGINS = [
  "https://portailgestion.ca",
  "https://www.portailgestion.ca",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

const ALLOWED_ORIGINS = (Deno.env.get("CC_ALLOWED_ORIGINS") ?? "")
  .split(",").map((o) => o.trim()).filter(Boolean);
const ORIGINS = ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : DEFAULT_ORIGINS;

export function corsHeadersFor(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin && ORIGINS.includes(origin) ? origin : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
}

export function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------------

// Même mécanisme que le Portail : on demande à Supabase Auth lui-même de
// valider le jeton, plutôt que d'en vérifier la signature localement. La
// passerelle Edge Functions rejette à tort les JWT ES256 quand
// verify_jwt=true (bug plateforme connu), donc verify_jwt reste à false
// et CE contrôle est la seule barrière — il doit donc être appelé par
// toute fonction qui touche à des données.
export async function verifySupabaseJwt(jwt: string): Promise<{ id: string; email?: string } | null> {
  if (!jwt) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${jwt}`, apikey: SERVICE_KEY },
    });
    if (!res.ok) return null;
    const user = await res.json().catch(() => null);
    return user?.id ? user : null;
  } catch {
    return null;
  }
}

export interface Member {
  id: string;
  user_id: string;
  full_name: string;
  role_label: string | null;
  is_admin: boolean;
  is_active: boolean;
  avatar_url: string | null;
}

// Le jeton prouve « quelqu'un s'est connecté avec Google ». Cette
// fonction répond à la vraie question : « est-ce quelqu'un de l'équipe ? »
// Une adresse inconnue passe la première étape et échoue ici.
export async function requireMember(req: Request): Promise<
  { ok: true; member: Member; userId: string } | { ok: false; status: number; error: string }
> {
  const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  const user = await verifySupabaseJwt(jwt);
  if (!user) return { ok: false, status: 401, error: "Jeton invalide ou expiré." };

  const rows = await db<Member>(
    `members?user_id=eq.${user.id}&is_active=is.true&select=id,user_id,full_name,role_label,is_admin,is_active,avatar_url`,
  );
  if (!rows.length) {
    return {
      ok: false,
      status: 403,
      error: "Ce compte Google n'est rattaché à aucun membre de l'équipe Lease Lane.",
    };
  }
  return { ok: true, member: rows[0], userId: user.id };
}

// ---------------------------------------------------------------------
// Accès base en service_role (contourne le RLS — réservé au serveur)
// ---------------------------------------------------------------------

const adminHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

export async function db<T = unknown>(path: string): Promise<T[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: adminHeaders });
  if (!res.ok) throw new Error(`Lecture ${path} : ${res.status} ${await res.text()}`);
  return await res.json();
}

export async function dbWrite<T = unknown>(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
  prefer = "return=representation",
): Promise<T[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { ...adminHeaders, Prefer: prefer },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Écriture ${path} : ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

export async function setting<T = unknown>(key: string, fallback: T): Promise<T> {
  try {
    const rows = await db<{ value: T }>(`app_settings?key=eq.${key}&select=value`);
    return rows.length ? rows[0].value : fallback;
  } catch {
    return fallback;
  }
}

export async function logActivity(entry: {
  entity_type: string;
  entity_id?: string | null;
  actor_kind?: "human" | "ai" | "system";
  member_id?: string | null;
  action: string;
  summary?: string;
  details?: Record<string, unknown>;
}) {
  try {
    await dbWrite("activity_log", "POST", { actor_kind: "system", ...entry }, "return=minimal");
  } catch {
    // Le journal ne doit jamais faire échouer l'action qu'il journalise.
  }
}

export async function logAiRun(entry: {
  function_name: string;
  model?: string;
  ok?: boolean;
  input_tokens?: number;
  output_tokens?: number;
  duration_ms?: number;
  detail?: string;
}) {
  try {
    await dbWrite("ai_run_log", "POST", entry, "return=minimal");
  } catch { /* idem */ }
}

// ---------------------------------------------------------------------
// Chiffrement des jetons Google (AES-GCM)
//
// Les jetons donnent accès aux boîtes courriel et aux agendas de
// l'équipe. La table google_accounts est déjà verrouillée au
// service_role (RLS sans aucune policy), mais une sauvegarde exportée ou
// un accès base direct suffirait à les lire en clair. Chiffrés ici, il
// faut EN PLUS le secret CC_TOKEN_KEY, qui ne vit que dans les secrets
// d'edge function et n'est jamais dans la base.
// ---------------------------------------------------------------------

function b64encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
// `Uint8Array.from()` renvoie un Uint8Array<ArrayBufferLike>, que
// WebCrypto refuse depuis TypeScript 5.7 (il exige un ArrayBuffer non
// partagé). Construire le tableau explicitement donne le bon type.
function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function tokenKey(): Promise<CryptoKey> {
  const raw = Deno.env.get("CC_TOKEN_KEY");
  if (!raw) throw new Error("CC_TOKEN_KEY manquant — impossible de chiffrer les jetons Google.");
  const bytes = b64decode(raw);
  if (bytes.length !== 32) throw new Error("CC_TOKEN_KEY doit faire 32 octets encodés en base64.");
  return await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptToken(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await tokenKey(), new TextEncoder().encode(plain));
  return `${b64encode(iv)}.${b64encode(new Uint8Array(ct))}`;
}

export async function decryptToken(stored: string): Promise<string> {
  const [ivPart, ctPart] = stored.split(".");
  if (!ivPart || !ctPart) throw new Error("Jeton chiffré illisible.");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(ivPart) },
    await tokenKey(),
    b64decode(ctPart),
  );
  return new TextDecoder().decode(plain);
}

// ---------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------

export interface GoogleAccount {
  id: string;
  member_id: string;
  google_email: string;
  refresh_token_enc: string | null;
  access_token_enc: string | null;
  access_token_expires: string | null;
  granted_scopes: string[];
  status: string;
  last_sync_at: string | null;
}

// Renvoie un jeton d'accès valide, en réutilisant celui en cache tant
// qu'il reste plus d'une minute à courir. Sans ce cache, chaque passe de
// synchronisation rafraîchirait 4 jetons pour rien.
export async function googleAccessToken(account: GoogleAccount): Promise<string> {
  if (account.access_token_enc && account.access_token_expires) {
    const expiresAt = new Date(account.access_token_expires).getTime();
    if (expiresAt - Date.now() > 60_000) {
      return await decryptToken(account.access_token_enc);
    }
  }
  if (!account.refresh_token_enc) {
    throw new Error(`Compte ${account.google_email} : aucun jeton de rafraîchissement, reconnexion nécessaire.`);
  }

  const refreshToken = await decryptToken(account.refresh_token_enc);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID") ?? "",
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    // Un refus ici veut presque toujours dire que l'accès a été révoqué
    // côté Google. On le marque pour que l'interface demande une
    // reconnexion, au lieu de réessayer en boucle toutes les 5 minutes.
    await dbWrite(`google_accounts?id=eq.${account.id}`, "PATCH", {
      status: "needs_reauth",
      last_error: `Rafraîchissement refusé par Google (${res.status}).`,
    }, "return=minimal");
    throw new Error(`Google a refusé de rafraîchir le jeton de ${account.google_email}.`);
  }

  const data = await res.json();
  const expires = new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString();
  await dbWrite(`google_accounts?id=eq.${account.id}`, "PATCH", {
    access_token_enc: await encryptToken(data.access_token),
    access_token_expires: expires,
    status: "active",
    last_error: null,
  }, "return=minimal");

  return data.access_token;
}

export async function googleApi<T = unknown>(
  token: string,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Google ${new URL(url).pathname} : ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return await res.json();
}

// ---------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------

export const DEFAULT_MODEL = "claude-opus-5";

// Appelle Claude en imposant la forme de la réponse via structured
// outputs : le modèle ne peut pas répondre autre chose que du JSON
// conforme au schéma, donc aucun parsing défensif n'est nécessaire côté
// appelant.
export async function askClaude<T = unknown>(opts: {
  functionName: string;
  // Accepte un tableau de blocs pour pouvoir marquer le contexte stable
  // (l'état du tableau, l'équipe) en cache_control : ce contexte est
  // identique d'un courriel à l'autre, le refacturer à chaque appel
  // serait du gaspillage pur.
  system: string | unknown[];
  content: unknown;               // string, ou blocs de contenu
  schema: Record<string, unknown>;
  model?: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}): Promise<T> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY manquant.");
  const model = opts.model ?? (await setting<string>("ai_model", DEFAULT_MODEL));
  const started = Date.now();

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 8000,
      system: opts.system,
      messages: [{ role: "user", content: opts.content }],
      thinking: { type: "adaptive" },
      output_config: {
        effort: opts.effort ?? "medium",
        format: { type: "json_schema", schema: opts.schema },
      },
    }),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    await logAiRun({ function_name: opts.functionName, model, ok: false, duration_ms: Date.now() - started, detail });
    throw new Error(`Anthropic ${res.status} : ${detail}`);
  }

  const data = await res.json();
  await logAiRun({
    function_name: opts.functionName,
    model,
    ok: data.stop_reason !== "refusal",
    input_tokens: data.usage?.input_tokens,
    output_tokens: data.usage?.output_tokens,
    duration_ms: Date.now() - started,
    detail: data.stop_reason === "refusal" ? `refus : ${data.stop_details?.category ?? "?"}` : undefined,
  });

  // stop_reason doit être lu AVANT content : sur un refus la réponse est
  // un 200 avec un contenu vide, pas une erreur HTTP.
  if (data.stop_reason === "refusal") {
    throw new Error(`Claude a refusé la demande (${data.stop_details?.category ?? "catégorie inconnue"}).`);
  }

  const text = (data.content ?? []).filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text).join("");
  if (!text) throw new Error("Réponse vide de Claude.");
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------
// Divers
// ---------------------------------------------------------------------

// Un cron ne doit pas être déclenchable par n'importe qui sur Internet :
// ces fonctions tournent en service_role et lisent toutes les boîtes.
export function assertCronSecret(req: Request): boolean {
  const expected = Deno.env.get("CC_CRON_SECRET");
  if (!expected) return false;
  const given = req.headers.get("x-cc-cron-secret") ?? "";
  // Comparaison à temps constant : une comparaison naïve laisse fuir la
  // longueur du préfixe correct, octet par octet.
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function truncate(s: string | null | undefined, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n) + "…";
}
