// Test de l'interface : sert les vrais fichiers du dépôt, simule Supabase
// et Google, puis vérifie que les 9 vues se rendent, que les interactions
// marchent, et qu'aucune donnée venue de l'extérieur (courriel, document)
// ne peut devenir du code exécutable dans la page.
//
//   node command-center/tests/ui_test.mjs
//
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png' };

// Serveur statique local : on teste les vrais fichiers du dépôt, pas une copie.
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'text/plain' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(8099, r));

// --- Données simulées, aux VRAIES formes renvoyées par les vues SQL -----
const now = Date.now(), iso = (d) => new Date(now + d*86400000).toISOString();
const DATA = {
  'v_tasks': [
    { id:'t1', code:'LL-001', title:"Ouvrir le compte bancaire Lease Lane", workstream:'Governance',
      owner_name:'Greg', owner_member_id:'m1', priority:'p0', is_critical:true, status:'in_progress',
      pct_complete:0.5, deadline:iso(-2).slice(0,10), days_left:-2, health:'late',
      notes:'La carte peut suivre.', definition_of_done:'Compte actif.', blocking_count:0, comment_count:1 },
    { id:'t2', code:'LL-012', title:"Audit de la plateforme", workstream:'Technology',
      owner_name:'Steven', owner_member_id:'m5', priority:'p0', is_critical:true, status:'in_progress',
      pct_complete:0.2, deadline:iso(2).slice(0,10), days_left:2, health:'due_soon',
      notes:null, definition_of_done:'Tout classé.', blocking_count:1, comment_count:0 },
    { id:'t3', code:'LL-042', title:"Choisir le CRM", workstream:'Sales', owner_name:'Xav',
      owner_member_id:'m2', priority:'p1', is_critical:false, status:'done', pct_complete:1,
      deadline:iso(-5).slice(0,10), days_left:-5, health:'done', blocking_count:0, comment_count:0 },
  ],
  'v_dashboard': [{ launch_date:'2026-10-01', days_to_launch:27, total_tasks:67, p0_total:61,
    p0_done:3, p0_open:58, blocked:1, late:4, due_soon:6, p0_completion_pct:4.9, overall_completion_pct:4.5 }],
  'v_owner_summary': [
    { member_id:'m1', full_name:'Greg', role_label:'CEO', position:1, open_p0:13, open_all:15, done_p0:2, blocked:0, late:2, total:15 },
    { member_id:'m5', full_name:'Steven', role_label:'Technologie', position:5, open_p0:19, open_all:20, done_p0:1, blocked:1, late:2, total:20 },
  ],
  'launch_gates': [{ id:'g1', position:1, label:'1. Signer un propriétaire', deadline:'2026-09-27',
    status:'in_progress', proof:'Mandat signé', members:{full_name:'Greg'} }],
  'decisions_risks': [{ id:'d1', kind:'risk', topic:"Réseau de fournisseurs insuffisant", owner_label:'Eliot',
    due:'2026-09-12', status:'active', resolution:'Bâtir des remplaçants par métier.',
    impact:"Mauvaise réponse d'urgence", tasks:{code:'LL-034'}, members:{full_name:'Eliot'} }],
  'ai_suggestions': [{ id:'s1', kind:'send_email', title:"Répondre au propriétaire du 4520 Sainte-Catherine",
    rationale:"Il demande une confirmation de la date d'intégration, déjà fixée au 27 septembre.",
    payload:{to:['proprio@exemple.com'],subject:'Confirmation',body:'Bonjour,\nC\'est confirmé.'},
    confidence:0.86, source_type:'email', status:'pending', created_at:iso(0) }],
  'v_email_digest': [{ id:'e1', google_account_id:'a1', account_email:'greg@leaselane.ca', account_owner:'Greg',
    from_email:'proprio@exemple.com', from_name:'M. Tremblay', subject:"Question sur l'intégration",
    ai_urgency:'urgent', ai_category:'proprietaire', ai_summary:"Demande de confirmer la date d'intégration.",
    ai_status:'done', received_at:iso(0), task_id:'t1', snippet:'Bonjour…' }],
  'v_agenda': [{ id:'c1', account_owner:'Greg', title:'Démo propriétaire', starts_at:iso(1),
    ends_at:iso(1), all_day:false, attendees:[{email:'x@y.ca'}], location:'Visioconférence',
    origin:'command_center', task_code:'LL-046', status:'confirmed' }],
  'documents': [{ id:'doc1', name:'Mandat de gestion V1.docx', mime_type:'application/vnd.google-apps.document',
    ai_summary:"Projet de mandat : 6 % du loyer, 10 % coordination des travaux.", ai_doc_type:'legal',
    ai_status:'done', web_view_link:'https://docs.google.com/x', modified_at:iso(-1) }],
  'kpi_definitions': [{ id:'k1', name:'Portes signées', definition:'Vers ~100 portes', position:1, members:{full_name:'Greg'} }],
  'activity_log': [{ id:'al1', actor_kind:'ai', action:'ai_updated_progress',
    summary:"LL-012 mis à jour par l'IA", created_at:iso(0), members:null }],
  'meetings': [{ id:'mt1', meets_on:'2026-09-06', status:'planned',
    brief:'# Semaine décisive\n\nLe compte bancaire bloque quatre autres tâches.', brief_at:iso(0) }],
  'meeting_priorities': [{ id:'p1', meeting_id:'mt1', rank:1, label:'Ouvrir le compte bancaire',
    blocker:"Sans compte, impossible d'encaisser", members:{full_name:'Greg'}, tasks:{code:'LL-001',title:'x'} }],
  'meeting_agenda': [{ id:'ag1', position:1, time_slot:'0–5 min', owner_label:'Greg',
    section:"Portrait de l'entreprise", required_output:'Portes signées, blocage principal' }],
  'notifications': [{ id:'n1', level:'urgent', title:'J-27 avant le lancement',
    body:'2 en retard : LL-001, LL-008', created_at:iso(0), read_at:null }],
  'task_comments': [], 'task_dependencies': [],
};

// Données hostiles présentes dès le départ : titre, résumé de courriel et
// nom de document contenant du HTML actif. Rien de tout ça ne doit
// s'exécuter — ces champs viennent de Gmail et de Drive, donc de l'extérieur.
DATA['v_tasks'].push({ id:'tx', code:'LL-999',
  title:'<img src=x onerror="window.__XSS=1">', workstream:'Test', owner_name:'Greg',
  owner_member_id:'m1', priority:'p0', is_critical:false, status:'not_started', pct_complete:0,
  deadline:null, days_left:null, health:'ok', blocking_count:0, comment_count:0, notes:null });
DATA['v_email_digest'].push({ id:'ex', google_account_id:'a1', account_owner:'Greg',
  from_email:'attaquant@exemple.com', from_name:'<script>window.__XSS2=1</script>',
  subject:'<svg onload="window.__XSS3=1">', ai_summary:'<iframe src="javascript:window.__XSS4=1">',
  ai_urgency:'normal', ai_status:'done', received_at:iso(0), task_id:null });

const SESSION = {
  me: { id:'m1', full_name:'Greg', role_label:'CEO / vision / offre / closing', is_admin:true, is_active:true },
  team: [
    { id:'m1', full_name:'Greg', role_label:'CEO', is_admin:true, is_active:true, position:1,
      member_emails:[{email:'greg.picard.2003@gmail.com',is_primary:true}] },
    { id:'m2', full_name:'Xav', role_label:'Ventes', is_admin:false, is_active:true, position:2, member_emails:[] },
    { id:'m5', full_name:'Steven', role_label:'Technologie', is_admin:false, is_active:true, position:5,
      member_emails:[{email:'steven@leaselane.ca',is_primary:true}] },
  ],
  settings: { launch_date:'2026-10-01', mailbox_visibility:'all', sync_enabled:true, ai_model:'claude-opus-5' },
  policies: [
    { kind:'send_email', label:'Envoyer un courriel', description:"Sort de l'entreprise.", mode:'approve', is_outbound:true },
    { kind:'comment_on_task', label:'Ajouter une note IA', description:'Résumé sur la tâche.', mode:'auto', is_outbound:false },
  ],
  connections: [{ id:'a1', member_id:'m1', google_email:'greg@leaselane.ca', status:'active',
    last_sync_at:iso(0), last_error:null, scope_count:4 }],
  my_connection: { id:'a1', member_id:'m1', google_email:'greg@leaselane.ca', status:'active' },
};

// Chromium préinstallé s'il existe (environnements CI), sinon celui que
// Playwright a téléchargé lui-même.
const preinstalled = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => fs.existsSync(p));
const browser = await chromium.launch({
  ...(preinstalled ? { executablePath: preinstalled } : {}),
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

// Config valide + client Supabase simulé, injectés avant tout script de page.
await page.addInitScript(({ data, session }) => {
  window.__DATA = data;
  window.CC_CONFIG_OVERRIDE = { SUPABASE_URL:'https://test.supabase.co', SUPABASE_ANON_KEY:'anon-test' };
  const origFetch = window.fetch;
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/rest/v1/')) {
      const table = u.split('/rest/v1/')[1].split('?')[0];
      return new Response(JSON.stringify(data[table] || []), { status:200, headers:{'Content-Type':'application/json'} });
    }
    if (u.includes('/functions/v1/cc-board-api')) {
      const b = JSON.parse(opts?.body || '{}');
      if (b.action === 'session') return new Response(JSON.stringify(session), { status:200 });
      return new Response(JSON.stringify({ ok:true }), { status:200 });
    }
    if (u.includes('/functions/v1/')) return new Response(JSON.stringify({ ok:true, slots:[] }), { status:200 });
    return origFetch(url, opts);
  };
  window.supabase = {
    createClient: () => ({
      auth: {
        getSession: async () => ({ data:{ session:{ access_token:'tok', user:{ email:'greg@leaselane.ca' } } } }),
        onAuthStateChange: () => ({ data:{ subscription:{ unsubscribe(){} } } }),
        signInWithOAuth: async () => ({ error:null }),
        signOut: async () => ({}),
      },
      from: () => ({ update:()=>({ eq:async()=>({error:null}), is:()=>({eq:async()=>({error:null})}) }),
                     insert: async () => ({ error:null }) }),
      channel: () => { const c = { on: () => c, subscribe: (cb) => { cb('SUBSCRIBED'); return c; } }; return c; },
    }),
  };
}, { data: DATA, session: SESSION });

// config.js réel remplacé par une config valide (le fichier du dépôt
// contient volontairement des marqueurs REMPLACER).
await page.route('**/config.js', r => r.fulfill({ contentType:'text/javascript',
  body: 'window.CC_CONFIG = window.CC_CONFIG_OVERRIDE;' }));

await page.goto('http://localhost:8099/index.html', { waitUntil:'networkidle' });
await page.waitForTimeout(700);

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { const r = await fn(); if (r) { pass++; console.log(`  ✅ ${name}`); }
        else { fail++; console.log(`  ❌ ${name}`); } }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${e.message}`); }
};

console.log('\n— Démarrage —');
await check("l'application s'affiche (pas l'écran de connexion)", async () =>
  await page.locator('#app.on').count() === 1);
await check('le nom de la personne connectée apparaît', async () =>
  (await page.locator('#me-name').textContent()).includes('Greg'));
await check('le temps réel est indiqué actif', async () =>
  (await page.locator('#live').textContent()).includes('temps réel'));
await check('les 9 onglets sont présents', async () =>
  await page.locator('#nav a').count() === 9);

console.log('\n— Chaque vue se rend —');
for (const [hash, must] of [
  ['dashboard', 'Jours avant lancement'], ['board', 'LL-001'], ['inbox', 'Approuver et exécuter'],
  ['emails', 'Question sur'], ['agenda', 'Démo propriétaire'], ['documents', 'Mandat de gestion'],
  ['risks', 'fournisseurs'], ['meeting', "Ordre du jour"], ['settings', 'Automatisations'],
]) {
  await page.evaluate(h => { location.hash = '#' + h; }, hash);
  await page.waitForTimeout(220);
  await check(`vue « ${hash} » affiche ses données`, async () =>
    (await page.locator('#view').textContent()).includes(must));
}

console.log('\n— Interactions —');
await page.evaluate(() => { location.hash = '#board'; });
await page.waitForTimeout(250);
await check('une ligne de tâche ouvre le panneau de détail', async () => {
  await page.locator('tr[data-task]').first().click();
  await page.waitForTimeout(350);
  return await page.locator('#drawer.on').count() === 1;
});
await check('le panneau contient les champs modifiables', async () =>
  await page.locator('[data-edit="status"]').count() === 1);
await check('Échap ferme le panneau', async () => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  return await page.locator('#drawer.on').count() === 0;
});
await check('le filtre par personne réduit la liste', async () => {
  await page.selectOption('[data-filter="owner"]', 'Steven');
  await page.waitForTimeout(250);
  const txt = await page.locator('#view tbody').textContent();
  return txt.includes('LL-012') && !txt.includes('LL-001');
});
await check("le champ de recherche ne perd pas le focus à la frappe", async () => {
  await page.selectOption('[data-filter="owner"]', '');
  await page.waitForTimeout(200);
  await page.locator('[data-filter="q"]').click();
  await page.keyboard.type('bancaire');
  await page.waitForTimeout(250);
  const focused = await page.evaluate(() => document.activeElement?.dataset?.filter);
  const txt = await page.locator('#view tbody').textContent();
  return focused === 'q' && txt.includes('LL-001') && !txt.includes('LL-012');
});
await check('le panneau de créneaux s\'ouvre depuis l\'agenda', async () => {
  await page.evaluate(() => { location.hash = '#agenda'; });
  await page.waitForTimeout(250);
  await page.locator('[data-act="find-slot"]').click();
  await page.waitForTimeout(300);
  return await page.locator('#slot-title').count() === 1;
});

await check('changer d\'onglet ferme le panneau ouvert', async () => {
  await page.locator('[data-act="find-slot"]').count();
  await page.evaluate(() => { location.hash = '#board'; });
  await page.waitForTimeout(250);
  return await page.locator('#drawer.on').count() === 0;
});

console.log('\n— Échappement HTML (une donnée ne doit jamais devenir du code) —');
const resetFilters = async () => {
  await page.keyboard.press('Escape');
  await page.evaluate(() => { location.hash = '#board'; });
  await page.waitForTimeout(250);
  await page.locator('[data-filter="q"]').fill('');
  await page.selectOption('[data-filter="owner"]', '');
  await page.waitForTimeout(250);
};

await check('un titre de tâche contenant du HTML est affiché, pas exécuté', async () => {
  await resetFilters();
  const txt = await page.locator('#view').textContent();
  const imgInjected = await page.locator('#view img[src="x"]').count();
  return txt.includes('onerror') && imgInjected === 0;
});
await check("l'expéditeur et le résumé d'un courriel hostile sont neutralisés", async () => {
  await page.evaluate(() => { location.hash = '#emails'; });
  await page.waitForTimeout(300);
  const txt = await page.locator('#view').textContent();
  const tags = await page.locator('#view script, #view svg, #view iframe').count();
  return txt.includes('window.__XSS2') && tags === 0;
});
await check('aucun script injecté ne s\'est exécuté', async () => {
  const r = await page.evaluate(() => [window.__XSS, window.__XSS2, window.__XSS3, window.__XSS4]);
  return r.every(v => v === undefined);
});
await check('le panneau de détail échappe aussi le titre', async () => {
  await resetFilters();
  await page.locator('tr[data-task="tx"]').click();
  await page.waitForTimeout(350);
  const inDrawer = await page.locator('#drawer-in img[src="x"]').count();
  const shown = (await page.locator('#drawer-in').textContent()).includes('onerror');
  await page.keyboard.press('Escape');
  return inDrawer === 0 && shown;
});

console.log('\n— Erreurs JavaScript —');
const real = errors.filter(e => !/favicon|net::ERR|Failed to load resource/i.test(e));
if (real.length) { fail++; console.log('  ❌ erreurs détectées :'); real.slice(0,6).forEach(e => console.log('     ' + e)); }
else { pass++; console.log('  ✅ aucune erreur JavaScript'); }

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} réussis, ${fail} échoués`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
