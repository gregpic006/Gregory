// =====================================================================
// LEASE LANE COMMAND CENTER — logique de l'interface
//
// Deux chemins d'accès aux données, choisis délibérément :
//
//   • Le TABLEAU (tâches, portes, décisions, KPI) est lu et écrit
//     directement par le navigateur via PostgREST, protégé par le RLS.
//     C'est ce qui rend le temps réel possible : Supabase Realtime
//     diffuse chaque changement à tous les navigateurs ouverts, sans
//     serveur intermédiaire à interroger.
//
//   • Tout ce qui touche aux jetons Google, aux automatisations ou à la
//     configuration passe par les edge functions, en service_role. Ces
//     données ne sont jamais exposées au navigateur.
// =====================================================================

(() => {
"use strict";

// ---------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------
const CFG = window.CC_CONFIG || {};
if (!CFG.SUPABASE_URL || CFG.SUPABASE_URL.includes("REMPLACER") ||
    !CFG.SUPABASE_ANON_KEY || CFG.SUPABASE_ANON_KEY.includes("REMPLACER")) {
  document.getElementById("setup").style.display = "block";
  return;
}

const sb = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const FN = `${CFG.SUPABASE_URL}/functions/v1`;

// Les trois autorisations qui font vivre le produit, demandées en même
// temps que la connexion. `access_type=offline` + `prompt=consent` sont
// ce qui fait que Google renvoie un jeton durable : sans eux, l'accès
// expire en une heure et la synchronisation s'arrête pendant la nuit.
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive.readonly",
].join(" ");

// ---------------------------------------------------------------------
// État
// ---------------------------------------------------------------------
const S = {
  me: null, team: [], settings: {}, policies: [], connections: [], myConnection: null,
  tasks: [], gates: [], decisions: [], suggestions: [], emails: [], agenda: [],
  docs: [], meeting: null, priorities: [], agendaPlan: [], kpis: [], notifications: [],
  activity: [], dash: {}, owners: [],
  view: "dashboard", filters: { owner: "", priority: "", status: "", stream: "", q: "" },
};

// ---------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STATUS_FR = { not_started: "À faire", in_progress: "En cours", waiting: "En attente",
  blocked: "Bloquée", at_risk: "À risque", done: "Terminée" };
const HEALTH_FR = { ok: "OK", due_soon: "Échéance proche", late: "En retard",
  blocked: "Bloquée", at_risk: "À risque", done: "Terminée" };
const PRIORITY_FR = { p0: "P0 — Lancement", p1: "P1 — 30 jours", p2: "P2 — Plus tard" };

function toast(msg, isErr) {
  const t = document.createElement("div");
  t.className = "toast" + (isErr ? " err" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), isErr ? 6000 : 3200);
}

function fdate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("fr-CA", { day: "2-digit", month: "short" });
}
function fdatetime(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString("fr-CA",
    { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

// Appel d'une edge function avec le jeton de la session courante.
async function callFn(name, body) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error("Session expirée.");
  const res = await fetch(`${FN}/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: CFG.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body || {}),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `Erreur ${res.status}`);
  return out;
}

// ---------------------------------------------------------------------
// Connexion
// ---------------------------------------------------------------------
$("google-btn").addEventListener("click", async () => {
  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: {
      scopes: GOOGLE_SCOPES,
      queryParams: { access_type: "offline", prompt: "consent" },
      redirectTo: window.location.href.split("#")[0],
    },
  });
  if (error) toast(error.message, true);
});

$("logout").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.reload();
});

// Google ne renvoie le jeton durable qu'au retour de l'écran de consentement.
// Il faut le transmettre TOUT DE SUITE au serveur : la session Supabase ne
// le conserve pas d'un rechargement de page à l'autre.
async function linkGoogleIfPossible(session) {
  if (!session?.provider_refresh_token) return;
  try {
    const out = await callFn("cc-link-google", {
      provider_refresh_token: session.provider_refresh_token,
      google_email: session.user?.email,
      scopes: GOOGLE_SCOPES.split(" "),
    });
    if (out.warning) toast(out.warning, true);
  } catch (e) {
    toast(`Connexion Google incomplète : ${e.message}`, true);
  }
}

// ---------------------------------------------------------------------
// Chargement
// ---------------------------------------------------------------------
async function loadSession() {
  const out = await callFn("cc-board-api", { action: "session" });
  S.me = out.me;
  S.team = out.team || [];
  S.settings = out.settings || {};
  S.policies = out.policies || [];
  S.connections = out.connections || [];
  S.myConnection = out.my_connection;
}

const sel = {
  tasks: "v_tasks?select=*&order=deadline.asc,code.asc",
  dash: "v_dashboard?select=*",
  owners: "v_owner_summary?select=*&order=position",
  gates: "launch_gates?select=*,members(full_name)&order=position",
  decisions: "decisions_risks?select=*,tasks(code),members(full_name)&order=due.asc",
  suggestions: "ai_suggestions?select=*&status=eq.pending&order=created_at.desc",
  emails: "v_email_digest?select=*&order=received_at.desc&limit=120",
  agenda: "v_agenda?select=*&order=starts_at.asc&limit=150",
  docs: "documents?select=*&order=modified_at.desc&limit=80",
  kpis: "kpi_definitions?select=*,members(full_name)&order=position",
  activity: "activity_log?select=*,members(full_name)&order=created_at.desc&limit=60",
};

// On passe par fetch plutôt que par le query-builder : les vues avec
// jointures et tris multiples s'expriment plus simplement en PostgREST
// brut, et c'est exactement la même requête.
async function fetchRest(path) {
  const { data: { session } } = await sb.auth.getSession();
  const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: CFG.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session?.access_token || CFG.SUPABASE_ANON_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`${path} : ${res.status}`);
  return await res.json();
}

async function loadAll() {
  const keys = Object.keys(sel);
  const results = await Promise.allSettled(keys.map((k) => fetchRest(sel[k])));
  results.forEach((r, i) => {
    const k = keys[i];
    if (r.status === "fulfilled") {
      S[k] = k === "dash" ? (r.value[0] || {}) : r.value;
    } else {
      console.warn(`Chargement ${k} :`, r.reason);
    }
  });
  await loadMeeting();
  await loadNotifications();
}

async function loadMeeting() {
  try {
    const rows = await fetchRest("meetings?select=*&order=meets_on.desc&limit=1");
    S.meeting = rows[0] || null;
    S.priorities = S.meeting
      ? await fetchRest(`meeting_priorities?select=*,members(full_name),tasks(code,title)`
        + `&meeting_id=eq.${S.meeting.id}&order=rank`)
      : [];
    S.agendaPlan = await fetchRest("meeting_agenda?select=*&order=position");
  } catch (e) { console.warn("réunion :", e); }
}

async function loadNotifications() {
  try {
    S.notifications = await fetchRest(
      "notifications?select=*&read_at=is.null&order=created_at.desc&limit=30");
  } catch (e) { console.warn("notifications :", e); }
}

// ---------------------------------------------------------------------
// Temps réel
//
// Un changement fait chez quelqu'un d'autre doit apparaître ici sans
// rafraîchir. On recharge la collection touchée plutôt que d'appliquer
// le delta : c'est un peu moins fin, mais toujours juste — les vues
// calculées (santé, jours restants, compteurs) ne peuvent pas se
// recalculer correctement à partir d'une seule ligne modifiée.
// ---------------------------------------------------------------------
let reloadTimer = null;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => { await loadAll(); render(); }, 400);
}

function subscribeRealtime() {
  const tables = ["tasks", "task_comments", "launch_gates", "decisions_risks", "ai_suggestions",
    "email_messages", "calendar_events", "documents", "activity_log", "notifications",
    "meetings", "meeting_priorities", "kpi_values", "members"];
  let ch = sb.channel("command-center");
  tables.forEach((t) => {
    ch = ch.on("postgres_changes", { event: "*", schema: "public", table: t }, scheduleReload);
  });
  ch.subscribe((status) => {
    const el = $("live");
    const on = status === "SUBSCRIBED";
    el.className = "live" + (on ? "" : " off");
    el.innerHTML = `<i></i> ${on ? "temps réel" : "hors ligne"}`;
  });
}

// ---------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------
const VIEWS = [
  ["dashboard", "Tableau de bord", () => 0],
  ["board", "Tâches", () => S.tasks.filter((t) => t.status !== "done" && t.health === "late").length],
  ["inbox", "Propositions", () => S.suggestions.length],
  ["emails", "Courriels", () => S.emails.filter((e) => e.ai_urgency === "urgent").length],
  ["agenda", "Agenda", () => 0],
  ["documents", "Documents", () => 0],
  ["risks", "Décisions & risques", () => S.decisions.filter((d) => d.status === "active").length],
  ["meeting", "Réunion", () => 0],
  ["settings", "Équipe & réglages", () => S.connections.filter((c) => c.status !== "active").length],
];

function renderNav() {
  $("nav").innerHTML = VIEWS.map(([id, label, count]) => {
    const n = count();
    return `<a href="#${id}" class="${S.view === id ? "active" : ""}">
      <span>${esc(label)}</span>
      <span class="count ${n ? "" : "zero"}">${n}</span></a>`;
  }).join("");
  $("me-name").textContent = S.me?.full_name || "—";
  $("me-role").textContent = (S.me?.role_label || "") + (S.me?.is_admin ? " · admin" : "");
}

window.addEventListener("hashchange", () => {
  S.view = (location.hash || "#dashboard").slice(1);
  closeDrawer();
  render();
});

// ---------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------
function render() {
  if (!VIEWS.some((v) => v[0] === S.view)) S.view = "dashboard";
  renderNav();
  $("view").innerHTML = ({
    dashboard: viewDashboard, board: viewBoard, inbox: viewInbox, emails: viewEmails,
    agenda: viewAgenda, documents: viewDocuments, risks: viewRisks, meeting: viewMeeting,
    settings: viewSettings,
  })[S.view]();
  window.scrollTo(0, 0);
}

function head(title, sub, actions) {
  return `<div class="head"><div><h2>${esc(title)}</h2><p>${esc(sub)}</p></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">${actions || ""}</div></div>`;
}

function healthPill(h) {
  return `<span class="pill ${h}">${esc(HEALTH_FR[h] || h)}</span>`;
}

// ----- Tableau de bord -----------------------------------------------
function viewDashboard() {
  const d = S.dash || {};
  const notifs = S.notifications.slice(0, 5);

  return head("Tableau de bord",
    `Lancement le ${d.launch_date || "—"} — ${d.days_to_launch ?? "—"} jours`,
    `<button class="btn ghost" data-act="sync">Synchroniser maintenant</button>`)

  + `<div class="grid stats" style="margin-bottom:18px">
      <div class="card stat"><div class="n">${d.days_to_launch ?? "—"}</div><div class="l">Jours avant lancement</div></div>
      <div class="card stat ${d.p0_completion_pct >= 80 ? "good" : ""}">
        <div class="n">${d.p0_completion_pct ?? 0}%</div><div class="l">Tâches P0 terminées</div>
        <div class="bar" style="margin-top:8px"><i style="width:${d.p0_completion_pct ?? 0}%"></i></div></div>
      <div class="card stat"><div class="n">${d.p0_open ?? 0}</div><div class="l">P0 ouvertes</div></div>
      <div class="card stat ${d.late ? "warn" : "good"}"><div class="n">${d.late ?? 0}</div><div class="l">En retard</div></div>
      <div class="card stat ${d.due_soon ? "warn" : ""}"><div class="n">${d.due_soon ?? 0}</div><div class="l">Échéance ≤ 3 jours</div></div>
      <div class="card stat ${d.blocked ? "warn" : ""}"><div class="n">${d.blocked ?? 0}</div><div class="l">Bloquées</div></div>
    </div>`

  + (notifs.length ? `<div class="card" style="margin-bottom:18px">
      <h3 class="serif" style="font-size:16px;margin-bottom:9px">À ton attention</h3>
      ${notifs.map((n) => `<div style="padding:7px 0;border-top:1px solid var(--paper-3)">
        <span class="pill ${n.level === "urgent" ? "late" : n.level === "warning" ? "due_soon" : ""}">${esc(n.level)}</span>
        <b style="margin-left:7px">${esc(n.title)}</b>
        <div style="font-size:12.5px;color:var(--muted);margin-top:3px">${esc(n.body || "")}</div></div>`).join("")}
      <button class="btn sm ghost" data-act="read-all" style="margin-top:10px">Tout marquer comme lu</button>
    </div>` : "")

  + `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr));align-items:start">
      <div class="card">
        <h3 class="serif" style="font-size:16px;margin-bottom:10px">Charge par personne</h3>
        <table><thead><tr><th>Personne</th><th>P0 ouvertes</th><th>Total ouvert</th><th>En retard</th></tr></thead>
        <tbody>${S.owners.map((o) => `<tr><td><b>${esc(o.full_name)}</b>
          <div style="font-size:11.5px;color:var(--muted)">${esc(o.role_label || "")}</div></td>
          <td class="mono">${o.open_p0}</td><td class="mono">${o.open_all}</td>
          <td class="mono" ${o.late ? 'style="color:var(--rust);font-weight:600"' : ""}>${o.late}</td></tr>`).join("")}
        </tbody></table>
      </div>

      <div class="card">
        <h3 class="serif" style="font-size:16px;margin-bottom:10px">Portes de lancement</h3>
        <table><thead><tr><th>Porte</th><th>Responsable</th><th>Échéance</th><th>Statut</th></tr></thead>
        <tbody>${S.gates.map((g) => `<tr class="click" data-gate="${g.id}">
          <td>${esc(g.label)}</td><td>${esc(g.members?.full_name || "—")}</td>
          <td class="mono">${fdate(g.deadline)}</td>
          <td><span class="pill ${g.status}">${esc(STATUS_FR[g.status] || g.status)}</span></td></tr>`).join("")}
        </tbody></table>
      </div>
    </div>`

  + `<div class="card" style="margin-top:14px">
      <h3 class="serif" style="font-size:16px;margin-bottom:10px">Dernière activité</h3>
      <ul class="timeline">${S.activity.slice(0, 12).map((a) => `<li class="${a.actor_kind === "ai" ? "ai" : ""}">
        <b>${esc(a.members?.full_name || (a.actor_kind === "ai" ? "IA" : "Système"))}</b> — ${esc(a.summary || a.action)}
        <div style="font-size:11px;margin-top:2px">${fdatetime(a.created_at)}</div></li>`).join("")}</ul>
    </div>`;
}

// ----- Tâches --------------------------------------------------------
function filteredTasks() {
  const f = S.filters;
  return S.tasks.filter((t) =>
    (!f.owner || t.owner_name === f.owner) &&
    (!f.priority || t.priority === f.priority) &&
    (!f.status || (f.status === "open" ? t.status !== "done" : t.status === f.status)) &&
    (!f.stream || t.workstream === f.stream) &&
    (!f.q || (t.title + " " + t.code + " " + (t.notes || "")).toLowerCase().includes(f.q.toLowerCase()))
  );
}

function viewBoard() {
  const streams = [...new Set(S.tasks.map((t) => t.workstream))].sort();
  const rows = filteredTasks();
  const f = S.filters;
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${cur === v ? "selected" : ""}>${esc(label)}</option>`;

  return head("Tâches", `${rows.length} affichée(s) sur ${S.tasks.length}`,
    `<button class="btn" data-act="new-task">Nouvelle tâche</button>`)
  + `<div class="filters">
      <select data-filter="owner"><option value="">Tout le monde</option>
        ${S.team.map((m) => opt(m.full_name, m.full_name, f.owner)).join("")}</select>
      <select data-filter="priority"><option value="">Toutes priorités</option>
        ${Object.entries(PRIORITY_FR).map(([k, v]) => opt(k, v, f.priority)).join("")}</select>
      <select data-filter="status"><option value="">Tous statuts</option>
        ${opt("open", "Non terminées", f.status)}
        ${Object.entries(STATUS_FR).map(([k, v]) => opt(k, v, f.status)).join("")}</select>
      <select data-filter="stream"><option value="">Tous chantiers</option>
        ${streams.map((s) => opt(s, s, f.stream)).join("")}</select>
      <input type="text" data-filter="q" placeholder="Rechercher…" value="${esc(f.q)}">
    </div>`
  + (rows.length ? `<div class="card" style="padding:0">
      <table><thead><tr><th>Code</th><th>Tâche</th><th>Responsable</th><th>Priorité</th>
        <th>Échéance</th><th>Jours</th><th>Statut</th><th>Santé</th></tr></thead>
      <tbody>${rows.map((t) => `<tr class="click" data-task="${t.id}">
        <td class="mono">${esc(t.code || "—")}</td>
        <td><b>${esc(t.title)}</b>
          <div style="font-size:11.5px;color:var(--muted)">${esc(t.workstream)}
          ${t.blocking_count ? ` · bloquée par ${t.blocking_count}` : ""}</div></td>
        <td>${esc(t.owner_name || "—")}</td>
        <td><span class="pill ${t.priority}">${esc(t.priority.toUpperCase())}</span></td>
        <td class="mono">${fdate(t.deadline)}</td>
        <td class="mono">${t.days_left ?? "—"}</td>
        <td><span class="pill ${t.status}">${esc(STATUS_FR[t.status])}</span></td>
        <td>${healthPill(t.health)}</td></tr>`).join("")}</tbody></table></div>`
    : `<div class="card empty"><b>Aucune tâche ne correspond</b>Ajuste les filtres ci-dessus.</div>`);
}

// ----- Propositions de l'IA ------------------------------------------
function viewInbox() {
  const pol = Object.fromEntries(S.policies.map((p) => [p.kind, p]));
  return head("Propositions en attente",
    "Ce que le Command Center veut faire, et qui attend ton accord.",
    S.suggestions.length > 1 ? `<button class="btn ghost" data-act="reject-all">Tout refuser</button>` : "")
  + (S.suggestions.length ? S.suggestions.map((s) => {
      const p = pol[s.kind] || {};
      return `<div class="sug" data-sug="${s.id}">
        <div class="k">${esc(p.label || s.kind)}${p.is_outbound ? " · sort de l'entreprise" : ""}
          ${s.confidence != null ? ` · confiance ${Math.round(s.confidence * 100)}%` : ""}</div>
        <h4>${esc(s.title)}</h4>
        <p>${esc(s.rationale || "")}</p>
        <pre>${esc(JSON.stringify(s.payload, null, 2))}</pre>
        <div class="acts">
          <button class="btn ok sm" data-approve="${s.id}">Approuver et exécuter</button>
          <button class="btn no sm" data-reject="${s.id}">Refuser</button>
          <span style="font-size:11.5px;color:var(--muted);margin-left:auto">${fdatetime(s.created_at)}</span>
        </div></div>`;
    }).join("")
    : `<div class="card empty"><b>Rien en attente</b>
        Les actions réversibles s'exécutent seules ; seules celles qui engagent
        l'entreprise arrivent ici. Tu peux ajuster ça dans Équipe &amp; réglages.</div>`);
}

// ----- Courriels ------------------------------------------------------
function viewEmails() {
  const byUrgency = { urgent: 0, high: 1, normal: 2, low: 3 };
  const rows = [...S.emails].sort((a, b) =>
    (byUrgency[a.ai_urgency] ?? 9) - (byUrgency[b.ai_urgency] ?? 9) ||
    new Date(b.received_at) - new Date(a.received_at));

  return head("Courriels", `${S.emails.length} message(s) des ${S.connections.length} compte(s) connecté(s), triés par l'IA`)
  + (rows.length ? `<div class="card" style="padding:0"><table>
      <thead><tr><th>Urgence</th><th>De</th><th>Objet et résumé</th><th>Boîte</th><th>Tâche</th><th>Reçu</th></tr></thead>
      <tbody>${rows.map((e) => `<tr class="click" data-email="${e.id}">
        <td>${e.ai_urgency ? `<span class="pill ${e.ai_urgency}">${esc(e.ai_urgency)}</span>`
          : `<span class="pill">${esc(e.ai_status)}</span>`}</td>
        <td>${esc(e.from_name || e.from_email || "—")}</td>
        <td><b>${esc(e.subject || "(sans objet)")}</b>
          <div style="font-size:12px;color:var(--muted);margin-top:2px">${esc(e.ai_summary || e.snippet || "")}</div>
          ${e.ai_category ? `<span class="pill" style="margin-top:4px">${esc(e.ai_category)}</span>` : ""}</td>
        <td style="font-size:12px">${esc(e.account_owner || "—")}</td>
        <td class="mono">${esc(e.task_id ? (S.tasks.find((t) => t.id === e.task_id)?.code || "—") : "—")}</td>
        <td class="mono" style="font-size:11.5px">${fdatetime(e.received_at)}</td></tr>`).join("")}
      </tbody></table></div>`
    : `<div class="card empty"><b>Aucun courriel synchronisé</b>
        Connecte un compte Google dans Équipe &amp; réglages, puis lance une synchronisation.</div>`);
}

// ----- Agenda ---------------------------------------------------------
function viewAgenda() {
  const now = Date.now();
  const upcoming = S.agenda.filter((e) => new Date(e.ends_at || e.starts_at).getTime() >= now);
  const days = {};
  upcoming.forEach((e) => {
    const k = (e.starts_at || "").slice(0, 10);
    (days[k] = days[k] || []).push(e);
  });

  return head("Agenda", `${upcoming.length} événement(s) à venir sur les ${S.connections.length} compte(s)`,
    `<button class="btn" data-act="find-slot">Trouver un créneau</button>`)
  + (upcoming.length ? Object.entries(days).map(([day, evs]) => `<div class="card" style="margin-bottom:12px">
      <h3 class="serif" style="font-size:15px;margin-bottom:9px">
        ${esc(new Date(day + "T12:00:00").toLocaleDateString("fr-CA",
          { weekday: "long", day: "numeric", month: "long" }))}</h3>
      ${evs.map((e) => `<div style="display:flex;gap:12px;padding:7px 0;border-top:1px solid var(--paper-3)">
        <span class="mono" style="min-width:96px;font-size:12px">
          ${e.all_day ? "journée" : new Date(e.starts_at).toLocaleTimeString("fr-CA",
            { hour: "2-digit", minute: "2-digit" })}</span>
        <div style="flex:1"><b>${esc(e.title)}</b>
          <div style="font-size:12px;color:var(--muted)">
            ${esc(e.account_owner || "")}${e.location ? " · " + esc(e.location) : ""}
            ${e.task_code ? ` · <span class="mono">${esc(e.task_code)}</span>` : ""}
            ${(e.attendees || []).length ? ` · ${(e.attendees || []).length} participant(s)` : ""}
          </div></div>
        ${e.origin === "command_center" ? `<span class="pill">auto</span>` : ""}</div>`).join("")}
    </div>`).join("")
    : `<div class="card empty"><b>Aucun événement à venir</b>
        L'agenda se remplit dès qu'un compte Google est connecté.</div>`);
}

// ----- Documents ------------------------------------------------------
function viewDocuments() {
  return head("Documents", `${S.docs.length} fichier(s) vus dans Drive`)
  + (S.docs.length ? `<div class="card" style="padding:0"><table>
      <thead><tr><th>Nom</th><th>Ce que l'IA en retient</th><th>Type</th><th>Modifié</th></tr></thead>
      <tbody>${S.docs.map((d) => `<tr>
        <td><b>${esc(d.name)}</b>
          ${d.web_view_link ? `<div><a href="${esc(d.web_view_link)}" target="_blank" rel="noopener"
            style="font-size:11.5px">ouvrir dans Drive ↗</a></div>` : ""}</td>
        <td style="font-size:12.5px;color:var(--muted)">${esc(d.ai_summary || "—")}</td>
        <td>${d.ai_doc_type ? `<span class="pill">${esc(d.ai_doc_type)}</span>` : `<span class="pill">${esc(d.ai_status)}</span>`}</td>
        <td class="mono" style="font-size:11.5px">${fdate(d.modified_at)}</td></tr>`).join("")}
      </tbody></table></div>`
    : `<div class="card empty"><b>Aucun document synchronisé</b>
        Les fichiers Drive modifiés récemment apparaîtront ici, résumés.</div>`);
}

// ----- Décisions & risques -------------------------------------------
function viewRisks() {
  const open = S.decisions.filter((d) => ["open", "active"].includes(d.status));
  const closed = S.decisions.filter((d) => !["open", "active"].includes(d.status));
  const tbl = (rows) => `<table><thead><tr><th>Type</th><th>Sujet</th><th>Responsable</th>
      <th>Échéance</th><th>Mitigation / décision</th><th>Impact si non réglé</th><th>Tâche</th><th></th></tr></thead>
    <tbody>${rows.map((d) => `<tr>
      <td><span class="pill ${d.kind === "risk" ? "late" : ""}">${d.kind === "risk" ? "risque" : "décision"}</span></td>
      <td><b>${esc(d.topic)}</b></td>
      <td>${esc(d.owner_label || d.members?.full_name || "—")}</td>
      <td class="mono">${fdate(d.due)}</td>
      <td style="font-size:12.5px;color:var(--muted)">${esc(d.resolution || "—")}</td>
      <td style="font-size:12.5px;color:var(--muted)">${esc(d.impact || "—")}</td>
      <td class="mono">${esc(d.tasks?.code || "—")}</td>
      <td>${["open", "active"].includes(d.status)
        ? `<button class="btn sm ghost" data-resolve="${d.id}">Régler</button>` : `<span class="pill done">réglé</span>`}</td>
      </tr>`).join("")}</tbody></table>`;

  return head("Décisions & risques", `${open.length} ouvert(s), ${closed.length} réglé(s)`,
    `<button class="btn" data-act="new-risk">Ajouter</button>`)
    + `<div class="card" style="padding:0">${tbl(open)}</div>`
    + (closed.length ? `<h3 class="serif" style="font-size:16px;margin:20px 0 9px">Réglés</h3>
        <div class="card" style="padding:0">${tbl(closed)}</div>` : "");
}

// ----- Réunion du dimanche -------------------------------------------
function viewMeeting() {
  const m = S.meeting;
  const byMember = {};
  S.priorities.forEach((p) => {
    const n = p.members?.full_name || "—";
    (byMember[n] = byMember[n] || []).push(p);
  });

  return head("Réunion du dimanche",
    m ? `Dossier du ${m.meets_on}${m.brief_at ? ` — préparé le ${fdate(m.brief_at)}` : ""}`
      : "Aucun dossier préparé pour l'instant",
    `<button class="btn ghost" data-act="build-brief">Préparer le dossier</button>`)

  + (m?.brief ? `<div class="card" style="margin-bottom:14px;white-space:pre-wrap;line-height:1.65">${esc(m.brief)}</div>` : "")

  + (Object.keys(byMember).length ? `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(290px,1fr))">
      ${Object.entries(byMember).map(([name, ps]) => `<div class="card">
        <h3 class="serif" style="font-size:16px;margin-bottom:8px">${esc(name)}</h3>
        <ol style="margin-left:16px;font-size:13px;line-height:1.75">
          ${ps.map((p) => `<li><b>${esc(p.label)}</b>
            ${p.tasks?.code ? ` <span class="mono" style="font-size:11px">${esc(p.tasks.code)}</span>` : ""}</li>`).join("")}
        </ol>
        ${ps[0]?.blocker ? `<div style="margin-top:9px;font-size:12.5px;color:var(--rust)">
          <b>Blocage :</b> ${esc(ps[0].blocker)}</div>` : ""}
      </div>`).join("")}</div>`
    : `<div class="card empty"><b>Pas encore de priorités</b>
        « Préparer le dossier » analyse le tableau et propose 3 priorités par personne
        pour les 7 prochains jours.</div>`)

  + `<h3 class="serif" style="font-size:16px;margin:22px 0 9px">Ordre du jour — 45 minutes</h3>
     <div class="card" style="padding:0"><table>
       <thead><tr><th>Temps</th><th>Qui</th><th>Section</th><th>Livrable attendu</th></tr></thead>
       <tbody>${(S.agendaPlan || []).map((a) => `<tr>
         <td class="mono">${esc(a.time_slot)}</td><td>${esc(a.owner_label || "")}</td>
         <td><b>${esc(a.section)}</b></td>
         <td style="font-size:12.5px;color:var(--muted)">${esc(a.required_output || "")}</td></tr>`).join("")}
       </tbody></table></div>`

  + `<h3 class="serif" style="font-size:16px;margin:22px 0 9px">KPI suivis</h3>
     <div class="card" style="padding:0"><table>
       <thead><tr><th>Personne</th><th>Indicateur</th><th>Définition</th></tr></thead>
       <tbody>${S.kpis.map((k) => `<tr><td>${esc(k.members?.full_name || "—")}</td>
         <td><b>${esc(k.name)}</b></td>
         <td style="font-size:12.5px;color:var(--muted)">${esc(k.definition || "")}</td></tr>`).join("")}
       </tbody></table></div>`;
}

// ----- Équipe & réglages ---------------------------------------------
function viewSettings() {
  const admin = S.me?.is_admin;
  const connByMember = Object.fromEntries(S.connections.map((c) => [c.member_id, c]));

  return head("Équipe & réglages",
    admin ? "Déclare une adresse et la personne peut se connecter — rien d'autre à faire."
          : "Seuls les administrateurs peuvent modifier ces réglages.")

  + `<div class="card" style="margin-bottom:14px">
      <h3 class="serif" style="font-size:16px;margin-bottom:10px">Équipe et comptes Google</h3>
      <table><thead><tr><th>Personne</th><th>Adresses déclarées</th><th>Compte Google</th>
        <th>Dernière synchro</th>${admin ? "<th></th>" : ""}</tr></thead>
      <tbody>${S.team.map((m) => {
        const c = connByMember[m.id];
        return `<tr>
          <td><b>${esc(m.full_name)}</b>${m.is_admin ? ` <span class="pill">admin</span>` : ""}
            <div style="font-size:11.5px;color:var(--muted)">${esc(m.role_label || "")}</div></td>
          <td>${(m.member_emails || []).length
            ? (m.member_emails || []).map((e) => `<div style="font-size:12px" class="mono">${esc(e.email)}
                ${admin ? `<button class="btn sm ghost" data-rm-email="${esc(e.email)}"
                  style="padding:1px 6px;margin-left:5px">✕</button>` : ""}</div>`).join("")
            : `<span style="font-size:12px;color:var(--muted)">aucune — ne peut pas se connecter</span>`}</td>
          <td>${c ? `<span class="pill ${c.status === "active" ? "done" : "late"}">${esc(c.status)}</span>
              <div style="font-size:11.5px;color:var(--muted)">${esc(c.google_email)}</div>
              ${c.last_error ? `<div style="font-size:11px;color:var(--rust)">${esc(c.last_error)}</div>` : ""}`
            : `<span style="font-size:12px;color:var(--muted)">non connecté</span>`}</td>
          <td class="mono" style="font-size:11.5px">${c ? fdatetime(c.last_sync_at) : "—"}</td>
          ${admin ? `<td>
            <button class="btn sm ghost" data-add-email="${m.id}" data-name="${esc(m.full_name)}">+ adresse</button>
            ${c ? `<button class="btn sm no" data-disconnect="${c.id}">Déconnecter</button>` : ""}
          </td>` : ""}</tr>`;
      }).join("")}</tbody></table>
    </div>`

  + `<div class="card" style="margin-bottom:14px">
      <h3 class="serif" style="font-size:16px;margin-bottom:4px">Automatisations</h3>
      <p style="font-size:12.5px;color:var(--muted);margin-bottom:11px">
        <b>Automatique</b> : l'IA agit seule. <b>Approbation</b> : elle propose, tu cliques.
        <b>Éteint</b> : elle n'y touche pas. Tout ce qui sort de l'entreprise est en approbation
        par défaut — c'est modifiable, mais réfléchis-y à deux fois.</p>
      <table><thead><tr><th>Action</th><th>Ce que ça fait</th><th>Mode</th></tr></thead>
      <tbody>${S.policies.map((p) => `<tr>
        <td><b>${esc(p.label)}</b>${p.is_outbound ? ` <span class="pill late">sortant</span>` : ""}</td>
        <td style="font-size:12.5px;color:var(--muted)">${esc(p.description || "")}</td>
        <td><select data-policy="${esc(p.kind)}" ${admin ? "" : "disabled"} style="min-width:135px">
          <option value="auto" ${p.mode === "auto" ? "selected" : ""}>Automatique</option>
          <option value="approve" ${p.mode === "approve" ? "selected" : ""}>Approbation</option>
          <option value="off" ${p.mode === "off" ? "selected" : ""}>Éteint</option>
        </select></td></tr>`).join("")}</tbody></table>
    </div>`

  + `<div class="card">
      <h3 class="serif" style="font-size:16px;margin-bottom:10px">Réglages généraux</h3>
      <div class="row2">
        <div class="field"><label>Date de lancement</label>
          <input type="date" data-setting="launch_date" value="${esc(S.settings.launch_date || "")}" ${admin ? "" : "disabled"}></div>
        <div class="field"><label>Visibilité des boîtes courriel</label>
          <select data-setting="mailbox_visibility" ${admin ? "" : "disabled"}>
            <option value="all" ${S.settings.mailbox_visibility === "all" ? "selected" : ""}>Toute l'équipe voit tout</option>
            <option value="own" ${S.settings.mailbox_visibility === "own" ? "selected" : ""}>Chacun sa boîte (résumés partagés)</option>
          </select></div>
        <div class="field"><label>Synchronisation Google</label>
          <select data-setting="sync_enabled" ${admin ? "" : "disabled"}>
            <option value="true" ${S.settings.sync_enabled !== false ? "selected" : ""}>Active</option>
            <option value="false" ${S.settings.sync_enabled === false ? "selected" : ""}>En pause</option>
          </select></div>
        <div class="field"><label>Modèle IA</label>
          <input type="text" data-setting="ai_model" value="${esc(S.settings.ai_model || "claude-opus-5")}" ${admin ? "" : "disabled"}></div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------
// Tiroir de détail d'une tâche
// ---------------------------------------------------------------------
async function openTask(id) {
  const t = S.tasks.find((x) => x.id === id);
  if (!t) return;
  const [comments, deps, emails, timeline] = await Promise.all([
    fetchRest(`task_comments?select=*,members(full_name)&task_id=eq.${id}&order=created_at.desc`),
    fetchRest(`task_dependencies?select=depends_on_id,tasks!task_dependencies_depends_on_id_fkey(code,title,status)&task_id=eq.${id}`),
    fetchRest(`v_email_digest?select=id,subject,from_email,received_at,ai_summary&task_id=eq.${id}&order=received_at.desc&limit=10`),
    fetchRest(`activity_log?select=*,members(full_name)&entity_id=eq.${id}&order=created_at.desc&limit=20`),
  ]).catch(() => [[], [], [], []]);

  const opt = (v, l, cur) => `<option value="${v}" ${cur === v ? "selected" : ""}>${esc(l)}</option>`;

  $("drawer-in").innerHTML = `
    <button class="close" data-act="close-drawer">×</button>
    <div class="mono" style="font-size:11px;color:var(--muted)">${esc(t.code || "")} · ${esc(t.workstream)}</div>
    <h3>${esc(t.title)}</h3>
    <div style="margin:8px 0 16px">${healthPill(t.health)}
      <span class="pill ${t.priority}">${esc(t.priority.toUpperCase())}</span>
      ${t.is_critical ? `<span class="pill late">critique</span>` : ""}</div>

    <div class="row2">
      <div class="field"><label>Statut</label>
        <select data-edit="status">${Object.entries(STATUS_FR).map(([k, v]) => opt(k, v, t.status)).join("")}</select></div>
      <div class="field"><label>Responsable</label>
        <select data-edit="owner_member_id"><option value="">—</option>
          ${S.team.map((m) => opt(m.id, m.full_name, t.owner_member_id)).join("")}</select></div>
      <div class="field"><label>Échéance</label>
        <input type="date" data-edit="deadline" value="${esc(t.deadline || "")}"></div>
      <div class="field"><label>Avancement (%)</label>
        <input type="number" min="0" max="100" step="5" data-edit="pct_complete"
          value="${Math.round((t.pct_complete || 0) * 100)}"></div>
    </div>
    <div class="field"><label>Priorité</label>
      <select data-edit="priority">${Object.entries(PRIORITY_FR).map(([k, v]) => opt(k, v, t.priority)).join("")}</select></div>
    <div class="field"><label>Notes</label><textarea data-edit="notes">${esc(t.notes || "")}</textarea></div>
    <button class="btn" data-save-task="${t.id}">Enregistrer</button>

    ${t.definition_of_done ? `<div style="margin-top:20px">
      <label style="font-family:'JetBrains Mono',monospace;font-size:10.5px;text-transform:uppercase;
        letter-spacing:.05em;color:var(--muted)">Définition de « terminé »</label>
      <p style="font-size:13px;margin-top:4px">${esc(t.definition_of_done)}</p></div>` : ""}

    ${deps.length ? `<div style="margin-top:18px">
      <label style="font-family:'JetBrains Mono',monospace;font-size:10.5px;text-transform:uppercase;
        letter-spacing:.05em;color:var(--muted)">Dépend de</label>
      ${deps.map((d) => `<div style="font-size:12.5px;padding:4px 0">
        <span class="mono">${esc(d.tasks?.code || "")}</span> ${esc(d.tasks?.title || "")}
        <span class="pill ${d.tasks?.status}">${esc(STATUS_FR[d.tasks?.status] || "")}</span></div>`).join("")}
      </div>` : ""}

    ${emails.length ? `<div style="margin-top:18px">
      <label style="font-family:'JetBrains Mono',monospace;font-size:10.5px;text-transform:uppercase;
        letter-spacing:.05em;color:var(--muted)">Courriels rattachés</label>
      ${emails.map((e) => `<div style="font-size:12.5px;padding:6px 0;border-top:1px solid var(--paper-3)">
        <b>${esc(e.subject || "(sans objet)")}</b>
        <div style="color:var(--muted)">${esc(e.from_email || "")} · ${fdatetime(e.received_at)}</div>
        <div style="color:var(--muted);margin-top:2px">${esc(e.ai_summary || "")}</div></div>`).join("")}
      </div>` : ""}

    <div style="margin-top:20px">
      <label style="font-family:'JetBrains Mono',monospace;font-size:10.5px;text-transform:uppercase;
        letter-spacing:.05em;color:var(--muted)">Commentaires</label>
      <textarea id="new-comment" placeholder="Ajouter un commentaire…" style="margin:6px 0"></textarea>
      <button class="btn sm" data-comment="${t.id}">Publier</button>
      ${comments.map((c) => `<div style="font-size:12.5px;padding:8px 0;border-top:1px solid var(--paper-3)">
        <b>${esc(c.members?.full_name || (c.author_kind === "ai" ? "IA" : "—"))}</b>
        <span style="color:var(--muted)"> · ${fdatetime(c.created_at)}</span>
        <div style="margin-top:3px;white-space:pre-wrap">${esc(c.body)}</div></div>`).join("")}
    </div>

    ${timeline.length ? `<div style="margin-top:20px">
      <label style="font-family:'JetBrains Mono',monospace;font-size:10.5px;text-transform:uppercase;
        letter-spacing:.05em;color:var(--muted)">Historique</label>
      <ul class="timeline">${timeline.map((a) => `<li class="${a.actor_kind === "ai" ? "ai" : ""}">
        <b>${esc(a.members?.full_name || (a.actor_kind === "ai" ? "IA" : "Système"))}</b> — ${esc(a.summary || a.action)}
        <div style="font-size:11px">${fdatetime(a.created_at)}</div></li>`).join("")}</ul></div>` : ""}
  `;
  $("drawer").classList.add("on");
}

function closeDrawer() { $("drawer").classList.remove("on"); }

// Trouver un créneau ET le réserver dans la foulée : chercher une
// disponibilité sans pouvoir la retenir n'évite aucun aller-retour.
function openSlotFinder() {
  $("drawer-in").innerHTML = `
    <button class="close" data-act="close-drawer">×</button>
    <h3>Trouver un créneau</h3>
    <p style="font-size:13px;color:var(--muted);margin-bottom:16px">
      La disponibilité vient directement de Google, agendas personnels compris.
      Seules les heures ouvrables (lun–ven, 9 h–17 h) sont proposées.</p>

    <div class="field"><label>Qui doit être présent</label>
      <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:4px">
        ${S.team.map((m) => `<label style="display:flex;gap:6px;align-items:center;font-size:13px;cursor:pointer">
          <input type="checkbox" data-slot-member value="${m.id}"
            ${m.id === S.me.id ? "checked" : ""}> ${esc(m.full_name)}</label>`).join("")}
      </div></div>

    <div class="row2">
      <div class="field"><label>Durée</label>
        <select id="slot-duration">
          <option value="30">30 minutes</option><option value="45">45 minutes</option>
          <option value="60">1 heure</option><option value="90">1 h 30</option>
        </select></div>
      <div class="field"><label>Tâche liée (facultatif)</label>
        <input type="text" id="slot-task" placeholder="LL-014"></div>
    </div>

    <button class="btn ghost" data-act="search-slots">Chercher les créneaux libres</button>
    <div id="slot-results" style="margin-top:14px"></div>

    <hr style="margin:22px 0;border:none;border-top:1px solid var(--line)">
    <div class="field"><label>Titre de la rencontre</label>
      <input type="text" id="slot-title" placeholder="Ex. Démo propriétaire — 4520 Sainte-Catherine"></div>
    <div class="field"><label>Invités externes (adresses séparées par des virgules)</label>
      <input type="text" id="slot-guests" placeholder="proprietaire@exemple.com">
      <p style="font-size:11.5px;color:var(--muted);margin-top:4px">
        Avec au moins un invité, Google envoie une vraie invitation. Sans invité,
        l'événement reste interne et silencieux.</p></div>
    <div class="field"><label>Description</label><textarea id="slot-desc"></textarea></div>
  `;
  $("drawer").classList.add("on");
}

// ---------------------------------------------------------------------
// Interactions (délégation d'événements : le HTML est réécrit à chaque
// rendu, donc attacher les écouteurs aux éléments serait perdu)
// ---------------------------------------------------------------------
document.addEventListener("click", async (ev) => {
  const el = ev.target.closest("[data-act],[data-task],[data-approve],[data-reject],[data-save-task],"
    + "[data-comment],[data-add-email],[data-rm-email],[data-disconnect],[data-resolve],[data-gate]");
  if (!el) return;

  try {
    if (el.dataset.act === "close-drawer") return closeDrawer();
    if (el.dataset.task) return await openTask(el.dataset.task);

    if (el.dataset.act === "sync") {
      el.disabled = true; el.textContent = "Synchronisation…";
      const out = await callFn("cc-board-api", { action: "sync_now" });
      toast(out.ok ? "Synchronisation lancée." : "La synchronisation a échoué.", !out.ok);
      await loadAll(); render();
      return;
    }

    if (el.dataset.act === "read-all") {
      await sb.from("notifications").update({ read_at: new Date().toISOString() })
        .is("read_at", null).eq("member_id", S.me.id);
      await loadNotifications(); render();
      return;
    }

    if (el.dataset.approve || el.dataset.reject) {
      const id = el.dataset.approve || el.dataset.reject;
      const decision = el.dataset.approve ? "approve" : "reject";
      el.disabled = true; el.textContent = decision === "approve" ? "Exécution…" : "…";
      const out = await callFn("cc-apply-suggestion", { suggestion_id: id, decision });
      const r = (out.results || [])[0] || {};
      toast(r.detail || (decision === "approve" ? "Action exécutée." : "Proposition refusée."),
        r.status === "failed");
      await loadAll(); render();
      return;
    }

    if (el.dataset.act === "reject-all") {
      if (!confirm(`Refuser les ${S.suggestions.length} propositions en attente ?`)) return;
      await callFn("cc-apply-suggestion",
        { suggestion_ids: S.suggestions.map((s) => s.id), decision: "reject" });
      await loadAll(); render();
      return;
    }

    if (el.dataset.saveTask) {
      const patch = {};
      document.querySelectorAll("[data-edit]").forEach((f) => {
        const k = f.dataset.edit;
        let v = f.value;
        if (k === "pct_complete") v = Math.max(0, Math.min(100, Number(v) || 0)) / 100;
        if (k === "deadline" && !v) v = null;
        if (k === "owner_member_id" && !v) v = null;
        patch[k] = v;
      });
      const { error } = await sb.from("tasks").update(patch).eq("id", el.dataset.saveTask);
      if (error) throw error;
      toast("Tâche enregistrée.");
      closeDrawer();
      await loadAll(); render();
      return;
    }

    if (el.dataset.comment) {
      const body = $("new-comment").value.trim();
      if (!body) return;
      const { error } = await sb.from("task_comments")
        .insert({ task_id: el.dataset.comment, member_id: S.me.id, body });
      if (error) throw error;
      await openTask(el.dataset.comment);
      return;
    }

    if (el.dataset.addEmail) {
      const email = prompt(`Adresse Google de ${el.dataset.name} :`);
      if (!email) return;
      await callFn("cc-board-api",
        { action: "team_add_email", member_id: el.dataset.addEmail, email });
      toast(`${email} peut maintenant se connecter.`);
      await loadSession(); render();
      return;
    }

    if (el.dataset.rmEmail) {
      if (!confirm(`Retirer ${el.dataset.rmEmail} ? Cette personne perdra l'accès.`)) return;
      await callFn("cc-board-api", { action: "team_remove_email", email: el.dataset.rmEmail });
      await loadSession(); render();
      return;
    }

    if (el.dataset.disconnect) {
      if (!confirm("Déconnecter ce compte Google ? Les courriels et événements déjà "
        + "synchronisés seront supprimés du Command Center.")) return;
      await callFn("cc-board-api", { action: "disconnect_account", account_id: el.dataset.disconnect });
      await loadSession(); await loadAll(); render();
      return;
    }

    if (el.dataset.resolve) {
      const { error } = await sb.from("decisions_risks")
        .update({ status: "resolved" }).eq("id", el.dataset.resolve);
      if (error) throw error;
      await loadAll(); render();
      return;
    }

    if (el.dataset.act === "new-task") {
      const title = prompt("Titre de la tâche :");
      if (!title) return;
      const { error } = await sb.from("tasks")
        .insert({ title, owner_member_id: S.me.id, source: "manual", created_by: S.me.id });
      if (error) throw error;
      await loadAll(); render();
      return;
    }

    if (el.dataset.act === "new-risk") {
      const topic = prompt("Sujet du risque ou de la décision :");
      if (!topic) return;
      const kind = confirm("OK = risque, Annuler = décision") ? "risk" : "decision";
      const { error } = await sb.from("decisions_risks")
        .insert({ kind, topic, owner_member_id: S.me.id, status: "active" });
      if (error) throw error;
      await loadAll(); render();
      return;
    }

    if (el.dataset.act === "build-brief") {
      el.disabled = true; el.textContent = "Analyse du tableau…";
      const out = await callFn("cc-board-api", { action: "digest_now", mode: "weekly" });
      toast(out.ok
        ? `Dossier prêt : ${out.result?.priorities ?? 0} priorités proposées.`
        : "La préparation du dossier a échoué.", !out.ok);
      await loadAll(); render();
      return;
    }

    if (el.dataset.act === "find-slot") return openSlotFinder();

    if (el.dataset.act === "search-slots") {
      const dur = Number(document.getElementById("slot-duration").value) || 30;
      const ids = [...document.querySelectorAll("[data-slot-member]:checked")].map((c) => c.value);
      if (!ids.length) return toast("Choisis au moins une personne.", true);
      el.disabled = true; el.textContent = "Recherche…";
      const out = await callFn("cc-agenda-api",
        { action: "find_slots", member_ids: ids, duration_minutes: dur, days_ahead: 14 });
      document.getElementById("slot-results").innerHTML = out.slots?.length
        ? out.slots.map((sl) => `<label style="display:flex;gap:9px;align-items:center;
              padding:7px 0;border-top:1px solid var(--paper-3);font-size:13px;cursor:pointer">
            <input type="radio" name="slot" value="${esc(sl.start)}|${esc(sl.end)}">
            <span>${esc(fdatetime(sl.start))} → ${esc(new Date(sl.end)
              .toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" }))}</span></label>`).join("")
          + `<button class="btn" data-act="book-slot" style="margin-top:12px">Réserver ce créneau</button>`
        : `<p style="font-size:13px;color:var(--muted);margin-top:10px">
             Aucun créneau commun libre en heures ouvrables sur 14 jours.</p>`;
      el.disabled = false; el.textContent = "Chercher les créneaux libres";
      return;
    }

    if (el.dataset.act === "book-slot") {
      const picked = document.querySelector('[name="slot"]:checked');
      if (!picked) return toast("Choisis un créneau.", true);
      const title = document.getElementById("slot-title").value.trim();
      if (!title) return toast("Donne un titre à la rencontre.", true);
      const guests = document.getElementById("slot-guests").value
        .split(/[,;\s]+/).map((x) => x.trim()).filter((x) => x.includes("@"));
      const [start, end] = picked.value.split("|");

      el.disabled = true; el.textContent = "Réservation…";
      const out = await callFn("cc-agenda-api", {
        action: "book", title, start, end, attendees: guests,
        description: document.getElementById("slot-desc").value.trim(),
        task_code: document.getElementById("slot-task").value.trim() || undefined,
      });
      toast(out.detail || "Rendez-vous créé.", !out.ok);
      closeDrawer();
      await loadAll(); render();
      return;
    }
  } catch (e) {
    toast(e.message || String(e), true);
    render();
  }
});

// Fermer le tiroir en cliquant à côté.
$("drawer").addEventListener("click", (e) => { if (e.target.id === "drawer") closeDrawer(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

// Filtres et réglages
document.addEventListener("input", (ev) => {
  const f = ev.target.dataset.filter;
  if (!f) return;
  S.filters[f] = ev.target.value;
  // On ne re-rend que le tableau : re-rendre toute la vue ferait perdre
  // le focus du champ de recherche à chaque frappe.
  const rows = filteredTasks();
  const body = document.querySelector("#view tbody");
  if (body && S.view === "board") {
    body.innerHTML = rows.map((t) => `<tr class="click" data-task="${t.id}">
      <td class="mono">${esc(t.code || "—")}</td>
      <td><b>${esc(t.title)}</b><div style="font-size:11.5px;color:var(--muted)">${esc(t.workstream)}</div></td>
      <td>${esc(t.owner_name || "—")}</td>
      <td><span class="pill ${t.priority}">${esc(t.priority.toUpperCase())}</span></td>
      <td class="mono">${fdate(t.deadline)}</td><td class="mono">${t.days_left ?? "—"}</td>
      <td><span class="pill ${t.status}">${esc(STATUS_FR[t.status])}</span></td>
      <td>${healthPill(t.health)}</td></tr>`).join("");
  }
});

document.addEventListener("change", async (ev) => {
  try {
    if (ev.target.dataset.policy) {
      await callFn("cc-board-api",
        { action: "policy_set", kind: ev.target.dataset.policy, mode: ev.target.value });
      toast("Automatisation mise à jour.");
      await loadSession();
      return;
    }
    if (ev.target.dataset.setting) {
      const key = ev.target.dataset.setting;
      let value = ev.target.value;
      if (value === "true") value = true;
      else if (value === "false") value = false;
      await callFn("cc-board-api", { action: "settings_set", key, value });
      toast("Réglage enregistré.");
      await loadSession(); await loadAll(); render();
      return;
    }
    if (ev.target.dataset.filter) {
      S.filters[ev.target.dataset.filter] = ev.target.value;
      render();
    }
  } catch (e) {
    toast(e.message, true);
  }
});

// ---------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------
async function start(session) {
  try {
    await linkGoogleIfPossible(session);
    await loadSession();
  } catch (e) {
    // Un compte Google valide mais non déclaré arrive ici : on le dit
    // clairement plutôt que d'afficher une application vide.
    $("login").style.display = "flex";
    $("login-note").innerHTML = `<b style="color:var(--rust)">${esc(e.message)}</b><br><br>
      Demande à un administrateur d'ajouter <span class="mono">${esc(session.user?.email || "")}</span>
      dans Équipe &amp; réglages.`;
    await sb.auth.signOut();
    return;
  }

  $("login").style.display = "none";
  $("app").classList.add("on");
  S.view = (location.hash || "#dashboard").slice(1);
  await loadAll();
  render();
  subscribeRealtime();
}

(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session) await start(session);
  else $("login").style.display = "flex";

  sb.auth.onAuthStateChange(async (event, s) => {
    if (event === "SIGNED_IN" && s && !$("app").classList.contains("on")) await start(s);
    if (event === "SIGNED_OUT") location.reload();
  });
})();

})();
