/**
 * Jeton d'acces, cote navigateur.
 *
 * Quand JARVIS est ouvert au reseau, chaque requete doit porter un jeton.
 * Le premier acces depuis un telephone se fait par un lien qui le contient
 * (`http://192.168.x.x:8787/?token=...`) — on ne peut pas taper un en-tete
 * HTTP dans un navigateur.
 *
 * Ce module fait trois choses, dans cet ordre.
 *
 * 1. Il recupere le jeton de l'URL et le range dans le stockage local.
 * 2. Il **efface le jeton de la barre d'adresse**, pour qu'il ne finisse pas
 *    dans l'historique, dans un signet ou dans une capture d'ecran partagee.
 * 3. Il enveloppe `fetch` pour ajouter l'en-tete a toutes les requetes de
 *    l'API. Envelopper plutot que modifier chaque appel garantit qu'aucun
 *    point d'appel n'est oublie — sur un telephone, un seul oubli produit une
 *    page a moitie vide sans explication.
 */

const STORAGE_KEY = "jarvis.token";
const HEADER = "X-Jarvis-Token";

function readStored(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    // Navigation privee ou stockage bloque: le jeton vaudra pour cette page.
    return "";
  }
}

function store(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    /* sans stockage, le jeton reste en memoire jusqu'au rechargement */
  }
}

let token = "";

/** Recupere le jeton de l'URL, le conserve, puis nettoie la barre d'adresse. */
function adoptTokenFromUrl(): void {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("token");
  if (!fromUrl) return;

  token = fromUrl;
  store(fromUrl);

  params.delete("token");
  const query = params.toString();
  const clean = window.location.pathname + (query ? `?${query}` : "") + window.location.hash;
  window.history.replaceState({}, "", clean);
}

/** Le jeton courant, ou une chaine vide en acces local. */
export function accessToken(): string {
  return token;
}

/** Ajoute le jeton a une URL de WebSocket, qui ne peut pas porter d'en-tete. */
export function withToken(url: string): string {
  if (!token) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

/** Oublie le jeton: utile pour retirer l'acces d'un appareil prete. */
export function forgetToken(): void {
  token = "";
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* rien a faire */
  }
}

/** A appeler une seule fois, avant tout appel reseau. */
export function installSession(): void {
  token = readStored();
  adoptTokenFromUrl();

  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (!token) return original(input, init);

    // Uniquement nos propres appels: on n'ajoute jamais le jeton a une requete
    // sortant vers un autre domaine.
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const sameOrigin = target.startsWith("/") || target.startsWith(window.location.origin);
    if (!sameOrigin) return original(input, init);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(HEADER, token);
    return original(input, { ...init, headers });
  };
}
