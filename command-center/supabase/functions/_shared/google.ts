// =====================================================================
// LEASE LANE COMMAND CENTER — lecture Gmail, Agenda et Drive
//
// Chaque fonction ici transforme une réponse d'API Google en lignes
// prêtes pour la base. Aucune n'écrit : c'est cc-google-sync qui décide
// quoi enregistrer, pour que la logique de synchronisation reste à un
// seul endroit.
// =====================================================================

import { googleApi, truncate } from "./cc.ts";

// ---------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------

interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
  headers?: { name: string; value: string }[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

// Gmail encode les corps en base64url (- et _ au lieu de + et /), sans
// padding. atob() ne l'accepte pas tel quel.
function decodeB64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Un courriel Gmail est un arbre MIME : le texte peut être à la racine,
// dans une branche multipart/alternative, ou seulement en HTML. On
// parcourt l'arbre en préférant text/plain, avec repli sur le HTML
// nettoyé — sinon les courriels des outils infonuagiques (qui n'envoient
// que du HTML) arriveraient vides.
function extractBody(part: GmailPart | undefined): string {
  if (!part) return "";
  const plain: string[] = [];
  const html: string[] = [];

  const walk = (p: GmailPart) => {
    const isAttachment = !!p.filename && p.filename.length > 0;
    if (!isAttachment && p.body?.data) {
      if (p.mimeType === "text/plain") plain.push(decodeB64Url(p.body.data));
      else if (p.mimeType === "text/html") html.push(decodeB64Url(p.body.data));
    }
    (p.parts ?? []).forEach(walk);
  };
  walk(part);

  const text = plain.join("\n").trim();
  return text || stripHtml(html.join("\n"));
}

function hasAttachments(part: GmailPart | undefined): boolean {
  if (!part) return false;
  if (part.filename && part.filename.length > 0 && part.body?.attachmentId) return true;
  return (part.parts ?? []).some(hasAttachments);
}

function header(msg: GmailMessage, name: string): string {
  const h = (msg.payload?.headers ?? []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

// « Greg Picard <greg@leaselane.ca> » → nom et adresse séparés.
function parseAddress(raw: string): { name: string | null; email: string | null } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim().toLowerCase() };
  const bare = raw.trim().toLowerCase();
  return { name: null, email: bare.includes("@") ? bare : null };
}

function parseAddressList(raw: string): string[] {
  if (!raw) return [];
  // Découpe sur les virgules hors guillemets — un nom peut en contenir
  // (« Picard, Greg <greg@…> »).
  return raw.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((p) => parseAddress(p).email)
    .filter((e): e is string => !!e);
}

export interface ParsedEmail {
  gmail_id: string;
  thread_id: string;
  from_email: string | null;
  from_name: string | null;
  to_emails: string[];
  cc_emails: string[];
  subject: string;
  snippet: string;
  body_text: string;
  received_at: string | null;
  is_unread: boolean;
  has_attachments: boolean;
  gmail_labels: string[];
}

export async function listNewGmailIds(
  token: string,
  sinceEpochSeconds: number | null,
  maxResults = 60,
): Promise<string[]> {
  // `after:` en secondes epoch cible précisément la dernière synchro.
  // Sans curseur (première connexion) on se limite à 14 jours : remonter
  // toute la boîte coûterait des milliers d'appels pour du contexte
  // périmé.
  const q = sinceEpochSeconds ? `after:${sinceEpochSeconds}` : "newer_than:14d";
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages`
    + `?maxResults=${maxResults}&q=${encodeURIComponent(`${q} -in:chats`)}`;
  const data = await googleApi<{ messages?: { id: string }[] }>(token, url);
  return (data.messages ?? []).map((m) => m.id);
}

export async function fetchGmailMessage(token: string, id: string): Promise<ParsedEmail> {
  const msg = await googleApi<GmailMessage>(
    token,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
  );
  const from = parseAddress(header(msg, "From"));
  const received = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null;

  return {
    gmail_id: msg.id,
    thread_id: msg.threadId,
    from_email: from.email,
    from_name: from.name,
    to_emails: parseAddressList(header(msg, "To")),
    cc_emails: parseAddressList(header(msg, "Cc")),
    subject: header(msg, "Subject"),
    snippet: msg.snippet ?? "",
    // Un corps entier peut faire plusieurs centaines de Ko (fils de
    // discussion cités en cascade). On garde de quoi comprendre et
    // trier, pas l'archive complète — Gmail reste la source.
    body_text: truncate(extractBody(msg.payload), 20000),
    received_at: received,
    is_unread: (msg.labelIds ?? []).includes("UNREAD"),
    has_attachments: hasAttachments(msg.payload),
    gmail_labels: msg.labelIds ?? [],
  };
}

export async function sendGmail(token: string, opts: {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
}): Promise<{ id: string; threadId: string }> {
  // Un sujet non-ASCII doit être encodé (RFC 2047), sinon les accents
  // arrivent en charabia chez le destinataire.
  const encodedSubject = /^[\x20-\x7E]*$/.test(opts.subject)
    ? opts.subject
    : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(opts.subject)))}?=`;

  const lines = [
    `To: ${opts.to.join(", ")}`,
    ...(opts.cc?.length ? [`Cc: ${opts.cc.join(", ")}`] : []),
    `Subject: ${encodedSubject}`,
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    btoa(String.fromCharCode(...new TextEncoder().encode(opts.body))),
  ];
  const raw = btoa(String.fromCharCode(...new TextEncoder().encode(lines.join("\r\n"))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  return await googleApi(token, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw, ...(opts.threadId ? { threadId: opts.threadId } : {}) }),
  });
}

export async function createGmailDraft(token: string, opts: {
  to: string[]; subject: string; body: string; threadId?: string;
}): Promise<{ id: string }> {
  const encodedSubject = /^[\x20-\x7E]*$/.test(opts.subject)
    ? opts.subject
    : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(opts.subject)))}?=`;
  const lines = [
    `To: ${opts.to.join(", ")}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    btoa(String.fromCharCode(...new TextEncoder().encode(opts.body))),
  ];
  const raw = btoa(String.fromCharCode(...new TextEncoder().encode(lines.join("\r\n"))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return await googleApi(token, "https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    body: JSON.stringify({ message: { raw, ...(opts.threadId ? { threadId: opts.threadId } : {}) } }),
  });
}

// ---------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------

interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; displayName?: string; responseStatus?: string }[];
  organizer?: { email?: string };
  updated?: string;
}

export interface ParsedEvent {
  google_event_id: string;
  calendar_id: string;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: string | null;
  ends_at: string | null;
  all_day: boolean;
  attendees: unknown;
  organizer_email: string | null;
  status: string;
  html_link: string | null;
}

function parseEvent(e: GEvent, calendarId: string): ParsedEvent {
  const allDay = !!e.start?.date && !e.start?.dateTime;
  return {
    google_event_id: e.id,
    calendar_id: calendarId,
    title: e.summary ?? "(sans titre)",
    description: e.description ?? null,
    location: e.location ?? null,
    starts_at: e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00Z` : null),
    ends_at: e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00Z` : null),
    all_day: allDay,
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.email, name: a.displayName ?? null, response: a.responseStatus ?? null,
    })),
    organizer_email: e.organizer?.email?.toLowerCase() ?? null,
    status: e.status ?? "confirmed",
    html_link: e.htmlLink ?? null,
  };
}

// Fenêtre volontairement courte (14 jours en arrière, 90 en avant) : le
// Command Center sert à piloter un lancement dans 4 semaines, pas à
// archiver l'agenda.
export async function listEvents(token: string, calendarId = "primary"): Promise<ParsedEvent[]> {
  const timeMin = new Date(Date.now() - 14 * 86400_000).toISOString();
  const timeMax = new Date(Date.now() + 90 * 86400_000).toISOString();
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
    + `?singleEvents=true&orderBy=startTime&maxResults=250`
    + `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`;
  const data = await googleApi<{ items?: GEvent[] }>(token, url);
  return (data.items ?? []).map((e) => parseEvent(e, calendarId));
}

export async function createEvent(token: string, calendarId: string, body: {
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  attendees?: string[];
  sendUpdates?: "all" | "none";
}): Promise<GEvent> {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
    + `?sendUpdates=${body.sendUpdates ?? "all"}`;
  return await googleApi<GEvent>(token, url, {
    method: "POST",
    body: JSON.stringify({
      summary: body.summary,
      description: body.description,
      location: body.location,
      start: { dateTime: body.start },
      end: { dateTime: body.end },
      attendees: (body.attendees ?? []).map((email) => ({ email })),
    }),
  });
}

export async function patchEvent(token: string, calendarId: string, eventId: string, body: Record<string, unknown>) {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}?sendUpdates=all`;
  return await googleApi<GEvent>(token, url, { method: "PATCH", body: JSON.stringify(body) });
}

// Créneaux réellement libres pour TOUT le monde — c'est ce qui permet de
// proposer une heure de rendez-vous sans faire l'aller-retour habituel.
export async function freeBusy(token: string, emails: string[], from: string, to: string) {
  return await googleApi<{ calendars: Record<string, { busy: { start: string; end: string }[] }> }>(
    token,
    "https://www.googleapis.com/calendar/v3/freeBusy",
    {
      method: "POST",
      body: JSON.stringify({ timeMin: from, timeMax: to, items: emails.map((id) => ({ id })) }),
    },
  );
}

// ---------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  webViewLink?: string;
  modifiedTime?: string;
}

export interface ParsedDoc {
  source_ref: string;
  name: string;
  mime_type: string;
  size_bytes: number | null;
  web_view_link: string | null;
  modified_at: string | null;
}

export async function listDriveFiles(token: string, sinceIso: string | null): Promise<ParsedDoc[]> {
  const clauses = ["trashed = false", "mimeType != 'application/vnd.google-apps.folder'"];
  if (sinceIso) clauses.push(`modifiedTime > '${sinceIso}'`);
  const url = `https://www.googleapis.com/drive/v3/files`
    + `?q=${encodeURIComponent(clauses.join(" and "))}`
    + `&orderBy=modifiedTime desc&pageSize=50`
    + `&fields=${encodeURIComponent("files(id,name,mimeType,size,webViewLink,modifiedTime)")}`;
  const data = await googleApi<{ files?: DriveFile[] }>(token, url);
  return (data.files ?? []).map((f) => ({
    source_ref: f.id,
    name: f.name,
    mime_type: f.mimeType,
    size_bytes: f.size ? Number(f.size) : null,
    web_view_link: f.webViewLink ?? null,
    modified_at: f.modifiedTime ?? null,
  }));
}

const GOOGLE_NATIVE_EXPORT: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

// Renvoie le texte d'un fichier quand c'est possible. Les formats Google
// natifs passent par /export ; le texte brut se télécharge directement ;
// tout le reste (PDF, images, binaires) renvoie null — ces fichiers sont
// envoyés à Claude en pièce jointe plutôt que convertis ici.
export async function fetchDriveText(token: string, fileId: string, mimeType: string): Promise<string | null> {
  const exportAs = GOOGLE_NATIVE_EXPORT[mimeType];
  const url = exportAs
    ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportAs)}`
    : mimeType.startsWith("text/") || mimeType === "application/json"
    ? `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
    : null;
  if (!url) return null;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return truncate(await res.text(), 30000);
}

// Un PDF est envoyé tel quel à Claude, qui sait le lire nativement.
export async function fetchDrivePdfBase64(token: string, fileId: string, maxBytes = 4_000_000): Promise<string | null> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > maxBytes) return null;
  // btoa par tranches : passer 4 Mo d'un coup à String.fromCharCode fait
  // dépasser la pile d'appels.
  let binary = "";
  for (let i = 0; i < buf.length; i += 8192) {
    binary += String.fromCharCode(...buf.subarray(i, i + 8192));
  }
  return btoa(binary);
}
