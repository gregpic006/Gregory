-- =====================================================================
-- LEASE LANE COMMAND CENTER — contenu initial du tableau
--
-- Généré depuis LeaseLane_Master_Task_Board.xlsx (2026-09-04) :
--   • 5 membres d'équipe
--   • 67 tâches (LL-001 → LL-067) avec dépendances résolues
--   • 8 portes de lancement
--   • 12 décisions & risques ouverts
--   • l'ordre du jour de la réunion du dimanche + 15 KPI
--
-- Idempotent : `on conflict do nothing` partout. Rejouer ce fichier ne
-- crée pas de doublon et n'écrase pas le travail déjà fait sur le
-- tableau — c'est un amorçage, pas une remise à zéro.
-- =====================================================================

-- Réglages généraux ---------------------------------------------------
insert into app_settings (key, value) values
  ('launch_date',        '"2026-10-01"'::jsonb),
  ('launch_target',      '"~10 propriétaires / ~100 portes"'::jsonb),
  ('company_name',       '"Lease Lane"'::jsonb),
  ('timezone',           '"America/Toronto"'::jsonb),
  ('mailbox_visibility', '"all"'::jsonb),
  ('meeting_weekday',    '0'::jsonb),
  ('meeting_time',       '"14:00"'::jsonb),
  ('digest_hour',        '7'::jsonb),
  ('sync_enabled',       'true'::jsonb)
on conflict (key) do nothing;

-- L'équipe ------------------------------------------------------------
-- Seule l'adresse de Greg est connue au départ ; il ajoute celles des
-- 4 autres depuis l'onglet Équipe. Dès qu'une adresse est déclarée, la
-- personne se connecte avec Google et son compte se rattache seul.
insert into members (full_name, role_label, is_admin, position) values
  ('Greg', 'CEO / vision / offre / closing', true, 1),
  ('Xav', 'Ventes / prospection / démos', false, 2),
  ('Andy', 'Marketing / acquisition', false, 3),
  ('Eliot', 'Opérations / onboarding / fournisseurs', false, 4),
  ('Steven', 'Technologie / IA / plateforme', false, 5)
on conflict do nothing;

insert into member_emails (member_id, email, is_primary)
select id, 'greg.picard.2003@gmail.com', true from members where full_name = 'Greg'
on conflict (email) do nothing;

-- Politique d'automatisation ------------------------------------------
-- Ce qui est réversible et interne tourne tout seul (`auto`).
-- Ce qui sort de l'entreprise ou touche un engagement demande un clic
-- (`approve`). Chaque ligne est réglable dans l'onglet Automatisations,
-- sans toucher au code.
insert into automation_policies (kind, label, description, mode, is_outbound) values
  ('link_email_to_task', 'Rattacher un courriel à une tâche', 'Le courriel apparaît dans la timeline de la tâche concernée.', 'auto', false),
  ('link_doc_to_task', 'Rattacher un document à une tâche', 'Le document lu dans Drive ou en pièce jointe est classé sur la bonne tâche.', 'auto', false),
  ('comment_on_task', 'Ajouter une note IA sur une tâche', 'Résumé de ce que le courriel ou le document apporte à la tâche.', 'auto', false),
  ('update_task_progress', 'Mettre à jour lavancement dune tâche', 'Passe une tâche en « en cours » ou ajuste le %, sans jamais la clore.', 'auto', false),
  ('create_task', 'Créer une nouvelle tâche', 'Une demande arrivée par courriel devient une tâche avec responsable et échéance.', 'approve', false),
  ('complete_task', 'Marquer une tâche terminée', 'Clore une tâche reste une décision humaine.', 'approve', false),
  ('change_deadline', 'Modifier une échéance', 'Déplacer une date engage tout le plan de lancement.', 'approve', false),
  ('flag_risk', 'Lever un risque ou un blocage', 'Ajoute une ligne dans Décisions & Risques quand un signal le justifie.', 'auto', false),
  ('notify_member', 'Notifier quelquun dans le Command Center', 'Notification interne, ne sort pas de lentreprise.', 'auto', false),
  ('create_internal_event', 'Créer un événement interne à lagenda', 'Bloc de travail ou réunion entre membres de léquipe uniquement.', 'auto', false),
  ('schedule_meeting', 'Fixer un rendez-vous avec une personne externe', 'Envoie une invitation à un propriétaire, un fournisseur, un avocat.', 'approve', true),
  ('reschedule_event', 'Déplacer ou annuler un rendez-vous', 'Touche lagenda de quelquun dautre.', 'approve', true),
  ('draft_email_reply', 'Préparer un brouillon de réponse', 'Le brouillon est écrit mais rien nest envoyé.', 'auto', false),
  ('send_email', 'Envoyer un courriel', 'Sort de lentreprise, au nom dun membre de léquipe. Toujours un clic.', 'approve', true),
  ('weekly_digest', 'Préparer le dossier de la réunion du dimanche', 'Synthèse de la semaine : avancement, blocages, priorités proposées.', 'auto', false)
on conflict (kind) do nothing;

-- Les 67 tâches ------------------------------------------------------
insert into tasks (code, workstream, title, owner_member_id, priority, is_critical,
                   start_date, deadline, status, pct_complete, dependency_note,
                   definition_of_done, notes, source)
select 'LL-001', 'Governance', 'Open Lease Lane bank account', (select id from members where full_name = 'Greg'), 'p0', true,
       '2026-09-04'::date, '2026-09-04'::date, 'in_progress', 0.5, null, 'Business account active and usable for Lease Lane expenses.', 'Card can follow after account.', 'board_import'
union all
select 'LL-002', 'Governance', 'Adopt Master Task Board as the single source of truth', (select id from members where full_name = 'Greg'), 'p0', true,
       '2026-09-04'::date, '2026-09-06'::date, 'in_progress', 0.75, null, 'All five owners use this board; every task has one owner and deadline.', 'Greg owns board until delegated later.', 'board_import'
union all
select 'LL-003', 'Governance', 'Run first 45-minute Sunday operating meeting', (select id from members where full_name = 'Greg'), 'p0', true,
       '2026-09-04'::date, '2026-09-06'::date, 'not_started', 0.0, 'LL-002', 'Meeting completed; 3 priorities per person assigned; blockers/decisions logged.', 'Recurring every Sunday afternoon.', 'board_import'
union all
select 'LL-004', 'Legal & Finance', 'Draft Lease Lane management agreement V1', (select id from members where full_name = 'Greg'), 'p0', true,
       '2026-09-04'::date, '2026-09-07'::date, 'not_started', 0.0, null, 'Draft includes 6% rent due under lease, 10% works coordination, annual term, TAL, emergencies, full-service powers.', 'Draft together, then lawyer review.', 'board_import'
union all
select 'LL-005', 'Legal & Finance', 'Send management agreement V1 for lawyer review', (select id from members where full_name = 'Greg'), 'p0', true,
       '2026-09-07'::date, '2026-09-08'::date, 'not_started', 0.0, 'LL-004', 'Lawyer receives complete draft and specific questions to validate.', 'Do not ask lawyer to start from blank page.', 'board_import'
union all
select 'LL-006', 'Legal & Finance', 'Finalize client contract for commercial use', (select id from members where full_name = 'Greg'), 'p0', true,
       '2026-09-09'::date, '2026-09-15'::date, 'not_started', 0.0, 'LL-005', 'Approved contract ready for e-signature and onboarding same day.', 'Annual structure; lawyer validates termination wording.', 'board_import'
union all
select 'LL-007', 'Legal & Finance', 'Decide applicant screening / credit-check charging model', (select id from members where full_name = 'Greg'), 'p0', false,
       '2026-09-04'::date, '2026-09-10'::date, 'not_started', 0.0, null, 'Written rule: owner-paid, recovered from first month, or another compliant model.', 'Open commercial decision.', 'board_import'
union all
select 'LL-008', 'Legal & Finance', 'Finalize rent-flow and bank-reconciliation architecture', (select id from members where full_name = 'Greg'), 'p0', true,
       '2026-09-04'::date, '2026-09-10'::date, 'not_started', 0.0, 'Steven input', 'Clear design for expected rent vs deposits, fund custody, reconciliation and owner visibility; legal/accounting implications confirmed.', 'Avoid mixing client funds with operating account.', 'board_import'
union all
select 'LL-009', 'Legal & Finance', 'Confirm legal corporate-name transition Portail → Lease Lane', (select id from members where full_name = 'Greg'), 'p0', false,
       '2026-09-04'::date, '2026-09-11'::date, 'not_started', 0.0, null, 'Decision and filing path documented; all external documents use Lease Lane.', 'Current corporation still under Portail name.', 'board_import'
union all
select 'LL-010', 'Governance', 'Document shareholder roles and decision rights (40/20/20/20)', (select id from members where full_name = 'Greg'), 'p1', false,
       '2026-09-06'::date, '2026-09-18'::date, 'not_started', 0.0, null, 'Written one-page RACI/decision-rights document for Greg/Xav/Eliot/Steven.', 'Later fold into shareholder agreement.', 'board_import'
union all
select 'LL-011', 'Governance', 'Launch shareholder-agreement review', (select id from members where full_name = 'Greg'), 'p1', false,
       '2026-09-18'::date, '2026-09-30'::date, 'not_started', 0.0, 'LL-010', 'Lawyer has instructions on vesting/departure/IP/non-compete/major decisions as applicable.', 'Not a launch blocker unless lawyer advises otherwise.', 'board_import'
union all
select 'LL-012', 'Technology', 'Complete platform audit: Green / Yellow / Red / Not required', (select id from members where full_name = 'Steven'), 'p0', true,
       '2026-09-04'::date, '2026-09-07'::date, 'in_progress', 0.2, null, 'Every critical function classified with owner, issue and ETA.', 'No vague ''in development'' status.', 'board_import'
union all
select 'LL-013', 'Technology', 'Demo full critical path to Greg and Eliot', (select id from members where full_name = 'Steven'), 'p0', true,
       '2026-09-07'::date, '2026-09-09'::date, 'not_started', 0.0, 'LL-012', 'Screen-share shows owner→building→unit→tenant→lease→request→Lia→ticket→vendor→invoice→owner view.', 'All breaks become tasks.', 'board_import'
union all
select 'LL-014', 'Technology', 'Owner portal: portfolio / buildings / units / leases operational', (select id from members where full_name = 'Steven'), 'p0', true,
       '2026-09-04'::date, '2026-09-18'::date, 'in_progress', 0.25, 'LL-012', 'Real owner can log in and see accurate portfolio information.', 'Use real test property data.', 'board_import'
union all
select 'LL-015', 'Technology', 'Tenant portal: login + service request operational', (select id from members where full_name = 'Steven'), 'p0', true,
       '2026-09-04'::date, '2026-09-18'::date, 'in_progress', 0.25, 'LL-012', 'Real tenant can log in and submit request with details/photos.', 'Must create traceable record.', 'board_import'
union all
select 'LL-016', 'Technology', 'Lia triage: classify request, urgency and trade', (select id from members where full_name = 'Steven'), 'p0', true,
       '2026-09-04'::date, '2026-09-18'::date, 'in_progress', 0.2, 'LL-015', 'Lia outputs correct urgency/category and next action using guardrails.', 'Material emergencies remain human-supervised at launch.', 'board_import'
union all
select 'LL-017', 'Technology', 'Work order lifecycle operational', (select id from members where full_name = 'Steven'), 'p0', true,
       '2026-09-08'::date, '2026-09-21'::date, 'not_started', 0.0, 'LL-016', 'Ticket moves from created→assigned→accepted→in progress→completed→closed with timestamps.', 'Visible internally and to owner.', 'board_import'
union all
select 'LL-018', 'Technology', 'Vendor dispatch and accept/refuse workflow operational', (select id from members where full_name = 'Steven'), 'p0', true,
       '2026-09-08'::date, '2026-09-21'::date, 'not_started', 0.0, 'LL-017; Eliot vendor data', 'Vendor receives suitable work, accepts/refuses, status is tracked.', 'Manual dispatch is temporary fallback only.', 'board_import'
union all
select 'LL-019', 'Technology', 'Vendor completion: photos + invoice upload operational', (select id from members where full_name = 'Steven'), 'p0', true,
       '2026-09-08'::date, '2026-09-21'::date, 'not_started', 0.0, 'LL-018', 'Completed work contains evidence and invoice attached to ticket.', 'Lease Lane validates invoice.', 'board_import'
union all
select 'LL-020', 'Technology', 'Owner visibility: works, status, costs and history', (select id from members where full_name = 'Steven'), 'p0', true,
       '2026-09-12'::date, '2026-09-21'::date, 'not_started', 0.0, 'LL-017; LL-019', 'Owner sees ticket history, status, costs and documents without calling Lease Lane.', 'Key sales argument.', 'board_import'
union all
select 'LL-021', 'Technology', 'Rent ledger: expected rent due under lease', (select id from members where full_name = 'Steven'), 'p0', true,
       '2026-09-08'::date, '2026-09-21'::date, 'not_started', 0.0, 'LL-014; LL-008', 'System knows monthly rent due per active lease even when unpaid.', 'Supports 6% fee basis.', 'board_import'
union all
select 'LL-022', 'Technology', 'Bank feed / reconciliation: identify received rent vs expected', (select id from members where full_name = 'Steven'), 'p0', true,
       '2026-09-10'::date, '2026-09-24'::date, 'not_started', 0.0, 'LL-008; LL-021', 'Transactions can be matched to expected rents and exceptions surfaced.', 'Exact integration depends on banking architecture.', 'board_import'
union all
select 'LL-023', 'Technology', 'Automated arrears workflow + human escalation', (select id from members where full_name = 'Steven'), 'p0', true,
       '2026-09-14'::date, '2026-09-24'::date, 'not_started', 0.0, 'LL-021', 'Missed rent triggers approved reminders, case history and escalation; no autonomous legal decision.', 'TAL admin managed by Lease Lane.', 'board_import'
union all
select 'LL-024', 'Technology', 'Lease Lane branding complete across platform and automated emails', (select id from members where full_name = 'Steven'), 'p0', true,
       '2026-09-04'::date, '2026-09-14'::date, 'in_progress', 0.4, null, 'No customer-facing ''Portail'' references remain.', 'Contracts already use Lease Lane.', 'board_import'
union all
select 'LL-025', 'Technology', 'Set up staging vs production and release discipline', (select id from members where full_name = 'Steven'), 'p0', true,
       '2026-09-04'::date, '2026-09-18'::date, 'not_started', 0.0, null, 'Separate environments; changes tested before production.', 'Required before scale.', 'board_import'
union all
select 'LL-026', 'Technology', 'Backups, restore test, permissions and audit logs', (select id from members where full_name = 'Steven'), 'p0', true,
       '2026-09-08'::date, '2026-09-22'::date, 'not_started', 0.0, 'LL-025', 'Backup restore is tested; least-privilege access; key actions are traceable.', 'Security launch gate.', 'board_import'
union all
select 'LL-027', 'Technology', 'Automation-failure alerts and operational exception queue', (select id from members where full_name = 'Steven'), 'p0', true,
       '2026-09-10'::date, '2026-09-22'::date, 'not_started', 0.0, 'LL-025', 'Failed automation creates visible alert/task for human follow-up.', 'No silent failures.', 'board_import'
union all
select 'LL-028', 'Technology', 'Load/performance test for high door count', (select id from members where full_name = 'Steven'), 'p0', true,
       '2026-09-21'::date, '2026-09-26'::date, 'not_started', 0.0, 'LL-014:LL-027', 'Documented load test shows acceptable response times and no critical failures at agreed test volume.', 'Sales have no artificial door cap.', 'board_import'
union all
select 'LL-029', 'Technology', 'Lia voice call design + phone escalation plan', (select id from members where full_name = 'Steven'), 'p1', false,
       '2026-09-10'::date, '2026-09-25'::date, 'not_started', 0.0, 'Eliot emergency matrix', 'Technical design for voice intake, identity, ticketing and human escalation.', 'Voice can follow shortly after launch if not stable.', 'board_import'
union all
select 'LL-030', 'Technology', 'Feature freeze: no non-critical large features', (select id from members where full_name = 'Steven'), 'p0', true,
       '2026-09-22'::date, '2026-09-22'::date, 'not_started', 0.0, 'Core path stable', 'Only P0 bugs, stability, security and critical automations after freeze.', 'Protect launch.', 'board_import'
union all
select 'LL-031', 'Operations', 'Build V1 owner onboarding checklist', (select id from members where full_name = 'Eliot'), 'p0', true,
       '2026-09-04'::date, '2026-09-08'::date, 'in_progress', 0.25, 'Greg knowledge transfer', 'Checklist covers data/documents/accesses/thresholds/vendors/open TAL/vacancies.', 'Exact pack can evolve after first test.', 'board_import'
union all
select 'LL-032', 'Operations', 'Create Welcome Lease Lane tenant pack', (select id from members where full_name = 'Eliot'), 'p0', true,
       '2026-09-05'::date, '2026-09-10'::date, 'not_started', 0.0, 'LL-031', 'Template explains portal, contact, payments, service requests, emergencies and Lia.', 'Automate later with Steven.', 'board_import'
union all
select 'LL-033', 'Operations', 'Build emergency severity matrix + escalation rules', (select id from members where full_name = 'Eliot'), 'p0', true,
       '2026-09-04'::date, '2026-09-10'::date, 'not_started', 0.0, null, 'Definition of urgent/non-urgent; immediate safe actions; escalation and owner notification rules.', 'Feeds Lia guardrails.', 'board_import'
union all
select 'LL-034', 'Operations', 'Recruit initial Québec vendor network', (select id from members where full_name = 'Eliot'), 'p0', true,
       '2026-09-04'::date, '2026-09-12'::date, 'in_progress', 0.1, null, 'Minimum network: plumbing, electrical, locksmith, handyman, HVAC, water damage, pest control, cleaning with backups.', 'Collect zone, availability, rates, insurance.', 'board_import'
union all
select 'LL-035', 'Operations', 'Create vendor master data sheet / onboarding fields', (select id from members where full_name = 'Eliot'), 'p0', true,
       '2026-09-04'::date, '2026-09-08'::date, 'not_started', 0.0, null, 'Standard fields ready for Steven dispatch logic.', 'Include priority-vendor flag.', 'board_import'
union all
select 'LL-036', 'Operations', 'Define works approval logic + emergency override', (select id from members where full_name = 'Eliot'), 'p0', true,
       '2026-09-05'::date, '2026-09-09'::date, 'not_started', 0.0, null, 'Owner-selected threshold is documented; emergency override defined.', 'Feeds contract + product.', 'board_import'
union all
select 'LL-037', 'Operations', 'Define invoice validation and initial quality-control process', (select id from members where full_name = 'Eliot'), 'p0', true,
       '2026-09-08'::date, '2026-09-14'::date, 'not_started', 0.0, 'LL-034', 'Who validates invoice, what evidence is required, when field QC is performed.', 'Scalable QC can evolve later.', 'board_import'
union all
select 'LL-038', 'Operations', 'Use new property closing as full onboarding test case', (select id from members where full_name = 'Eliot'), 'p0', true,
       '2026-09-11'::date, '2026-09-14'::date, 'not_started', 0.0, 'LL-031; platform access', 'Real property entered from source docs; every step documented and pain point logged.', 'Greg teaches, Eliot executes.', 'board_import'
union all
select 'LL-039', 'Operations', 'Document top 10 operating SOPs from test case', (select id from members where full_name = 'Eliot'), 'p0', true,
       '2026-09-11'::date, '2026-09-18'::date, 'not_started', 0.0, 'LL-038', 'Repeatable SOPs exist for onboarding, tenant changeover, service request, emergency, arrears, vacancy, vendor, invoice, closure, owner update.', 'Keep concise/checklist-based.', 'board_import'
union all
select 'LL-040', 'Operations', 'Pilot onboarding: Eliot runs process with Greg observing', (select id from members where full_name = 'Eliot'), 'p0', true,
       '2026-09-15'::date, '2026-09-21'::date, 'not_started', 0.0, 'LL-038; LL-039', 'Eliot completes onboarding without Greg doing the work.', 'Handoff milestone.', 'board_import'
union all
select 'LL-041', 'Operations', 'Define day-1 service coverage by geography', (select id from members where full_name = 'Eliot'), 'p0', false,
       '2026-09-08'::date, '2026-09-12'::date, 'not_started', 0.0, 'LL-034', 'Document supported zones and vendor coverage gaps.', 'Sell broadly only where service can be delivered.', 'board_import'
union all
select 'LL-042', 'Sales', 'Select CRM and create Lease Lane sales pipeline', (select id from members where full_name = 'Xav'), 'p0', true,
       '2026-09-04'::date, '2026-09-06'::date, 'not_started', 0.0, 'Greg approval', 'CRM stages: Identified→Contacted→Qualified→Meeting→Demo→Proposal→Negotiation→Signed→Onboarding→Active.', 'Do not build custom CRM now.', 'board_import'
union all
select 'LL-043', 'Sales', 'Build initial prospect list: 50+ owners', (select id from members where full_name = 'Xav'), 'p0', true,
       '2026-09-04'::date, '2026-09-08'::date, 'in_progress', 0.2, 'LL-042', '50+ qualified owner records with doors, region and contact info.', 'Prioritize zones Lease Lane can serve.', 'board_import'
union all
select 'LL-044', 'Sales', 'Refine outbound call/email scripts with Greg', (select id from members where full_name = 'Xav'), 'p0', false,
       '2026-09-04'::date, '2026-09-08'::date, 'in_progress', 0.4, null, 'One standard call script, one email, one follow-up sequence ready to test.', 'Capture objections.', 'board_import'
union all
select 'LL-045', 'Sales', 'Run first 10 qualified owner conversations', (select id from members where full_name = 'Xav'), 'p0', true,
       '2026-09-07'::date, '2026-09-13'::date, 'not_started', 0.0, 'LL-043; LL-044', '10 real conversations logged with objections and next steps.', 'Learning KPI before volume.', 'board_import'
union all
select 'LL-046', 'Sales', 'Standardize 7-minute Lease Lane demo', (select id from members where full_name = 'Xav'), 'p0', true,
       '2026-09-07'::date, '2026-09-12'::date, 'not_started', 0.0, 'Platform demo path', 'Demo tells one story: pain→request→action→traceability→owner visibility.', 'Avoid random feature tour.', 'board_import'
union all
select 'LL-047', 'Sales', 'Review and finalize owner-facing PDF deck', (select id from members where full_name = 'Xav'), 'p0', false,
       '2026-09-04'::date, '2026-09-09'::date, 'not_started', 0.0, 'Greg input', 'Deck matches Lease Lane offer, pricing and current product reality.', 'No Portail references.', 'board_import'
union all
select 'LL-048', 'Sales', 'Start pre-selling owners for Oct 1+ onboarding', (select id from members where full_name = 'Xav'), 'p0', true,
       '2026-09-08'::date, '2026-09-30'::date, 'not_started', 0.0, 'LL-006; LL-046', 'Signed or committed owners have scheduled onboarding date.', 'Do not promise unavailable features.', 'board_import'
union all
select 'LL-049', 'Sales', 'Target ~10 owners / ~100 doors signed or very advanced', (select id from members where full_name = 'Greg'), 'p0', true,
       '2026-09-08'::date, '2026-10-01'::date, 'not_started', 0.0, 'Sales + marketing funnel', 'Pipeline supports launch target with clear owner/door totals.', 'Greg/Xav close.', 'board_import'
union all
select 'LL-050', 'Marketing', 'Edit promo video with Xav', (select id from members where full_name = 'Andy'), 'p0', true,
       '2026-09-04'::date, '2026-09-08'::date, 'in_progress', 0.1, 'Footage filmed', 'Approved master plus vertical social cut with subtitles and CTA.', 'Studio can assist.', 'board_import'
union all
select 'LL-051', 'Marketing', 'Audit Meta Business Manager configuration', (select id from members where full_name = 'Andy'), 'p0', true,
       '2026-09-04'::date, '2026-09-07'::date, 'not_started', 0.0, null, 'Page, Instagram, ad account, permissions, billing and ownership verified.', 'Escalate technical gaps.', 'board_import'
union all
select 'LL-052', 'Marketing', 'Verify Pixel / Conversions API / lead events', (select id from members where full_name = 'Andy'), 'p0', true,
       '2026-09-04'::date, '2026-09-10'::date, 'not_started', 0.0, 'LL-051; Steven if needed', 'Test event fires correctly from final lead destination.', 'Track real funnel.', 'board_import'
union all
select 'LL-053', 'Marketing', 'Choose ad destination and funnel', (select id from members where full_name = 'Andy'), 'p0', true,
       '2026-09-04'::date, '2026-09-07'::date, 'not_started', 0.0, 'Xav/Greg input', 'Written funnel: Meta→landing/form→CRM→owner assignment→meeting.', 'No paid scale before this.', 'board_import'
union all
select 'LL-054', 'Marketing', 'Build/finish lead landing page or Meta lead form', (select id from members where full_name = 'Andy'), 'p0', true,
       '2026-09-07'::date, '2026-09-12'::date, 'not_started', 0.0, 'LL-053; Steven/dev support', 'Mobile flow captures owner, doors, region, contact and CTA.', 'Keep friction low.', 'board_import'
union all
select 'LL-055', 'Marketing', 'Connect lead capture → CRM → notification', (select id from members where full_name = 'Andy'), 'p0', true,
       '2026-09-08'::date, '2026-09-13'::date, 'not_started', 0.0, 'LL-042; LL-054', 'Test lead appears in CRM and alerts Greg/Xav/Andy with owner assigned.', 'No lost leads.', 'board_import'
union all
select 'LL-056', 'Marketing', 'Create Lease Lane LinkedIn company page', (select id from members where full_name = 'Andy'), 'p1', false,
       '2026-09-05'::date, '2026-09-12'::date, 'not_started', 0.0, 'Brand assets', 'Page live with correct branding and contact info.', 'Supports credibility.', 'board_import'
union all
select 'LL-057', 'Marketing', 'Create/verify Google Business profile', (select id from members where full_name = 'Andy'), 'p1', false,
       '2026-09-05'::date, '2026-09-15'::date, 'not_started', 0.0, 'Company info', 'Profile submitted/verified where applicable.', 'Local trust channel.', 'board_import'
union all
select 'LL-058', 'Marketing', 'Prepare minimum viable organic profile content', (select id from members where full_name = 'Andy'), 'p1', false,
       '2026-09-08'::date, '2026-09-15'::date, 'not_started', 0.0, 'Brand + video', 'At least 3 strong posts including explainer and founder/video content.', 'No need for huge content bank.', 'board_import'
union all
select 'LL-059', 'Marketing', 'Run end-to-end test lead from ad/form to booked meeting', (select id from members where full_name = 'Andy'), 'p0', true,
       '2026-09-12'::date, '2026-09-15'::date, 'not_started', 0.0, 'LL-055', 'Test lead completes whole chain without manual searching.', 'Gate before paid scale.', 'board_import'
union all
select 'LL-060', 'Marketing', 'Launch controlled Meta campaign', (select id from members where full_name = 'Andy'), 'p0', false,
       '2026-09-15'::date, '2026-09-18'::date, 'not_started', 0.0, 'LL-050:LL-059', 'Campaign live with tracking and daily lead review.', 'Scale on qualified meetings, not clicks.', 'board_import'
union all
select 'LL-061', 'Testing & Launch', 'Scenario test: water leak / maintenance request end-to-end', (select id from members where full_name = 'Eliot'), 'p0', true,
       '2026-09-15'::date, '2026-09-18'::date, 'not_started', 0.0, 'Tech work order path + vendor', 'Request→Lia→approval→dispatch→work→photos→invoice→owner view passes.', 'Time each step.', 'board_import'
union all
select 'LL-062', 'Testing & Launch', 'Scenario test: unpaid rent / reminders / escalation', (select id from members where full_name = 'Eliot'), 'p0', true,
       '2026-09-16'::date, '2026-09-19'::date, 'not_started', 0.0, 'LL-021; LL-023', 'Expected rent remains due; reminders and escalation recorded; owner visibility correct.', 'No autonomous TAL legal decision.', 'board_import'
union all
select 'LL-063', 'Testing & Launch', 'Scenario test: vacant unit → applicant → lease', (select id from members where full_name = 'Eliot'), 'p0', true,
       '2026-09-17'::date, '2026-09-20'::date, 'not_started', 0.0, 'Leasing functions', 'Vacancy workflow tested through signed lease and activation of management fee.', 'Screening-charge rule noted.', 'board_import'
union all
select 'LL-064', 'Testing & Launch', 'Fix all P0 defects from scenario tests', (select id from members where full_name = 'Steven'), 'p0', true,
       '2026-09-18'::date, '2026-09-27'::date, 'not_started', 0.0, 'LL-061:LL-063', 'No unresolved P0 bug on critical path.', 'P1/P2 can remain documented.', 'board_import'
union all
select 'LL-065', 'Testing & Launch', 'Run launch rehearsal with fresh test owner/tenant', (select id from members where full_name = 'Greg'), 'p0', true,
       '2026-09-25'::date, '2026-09-27'::date, 'not_started', 0.0, 'LL-064', 'A person not involved in build can complete core journey with team operating normally.', 'Final reality check.', 'board_import'
union all
select 'LL-066', 'Testing & Launch', 'Go / No-Go review', (select id from members where full_name = 'Greg'), 'p0', true,
       '2026-09-29'::date, '2026-09-29'::date, 'not_started', 0.0, 'LL-065', 'Greg, Xav, Andy, Eliot, Steven each answer launch-gate questions; blockers get named owner/24h plan.', 'No vague green light.', 'board_import'
union all
select 'LL-067', 'Testing & Launch', 'Public launch Lease Lane', (select id from members where full_name = 'Greg'), 'p0', true,
       '2026-10-01'::date, '2026-10-01'::date, 'not_started', 0.0, 'LL-066', 'Unknown prospect can discover→book→sign→onboard→receive service.', 'Launch definition.', 'board_import'
on conflict (code) do nothing;

-- Dépendances résolues (69 liens) ---------------------------------
-- Les plages du fichier Excel (« LL-061:LL-063 ») sont développées en
-- liens un-à-un ; les dépendances en texte libre (« Greg approval »)
-- restent dans dependency_note, telles quelles.
insert into task_dependencies (task_id, depends_on_id)
select (select id from tasks where code = 'LL-003'), (select id from tasks where code = 'LL-002')
union all
select (select id from tasks where code = 'LL-005'), (select id from tasks where code = 'LL-004')
union all
select (select id from tasks where code = 'LL-006'), (select id from tasks where code = 'LL-005')
union all
select (select id from tasks where code = 'LL-011'), (select id from tasks where code = 'LL-010')
union all
select (select id from tasks where code = 'LL-013'), (select id from tasks where code = 'LL-012')
union all
select (select id from tasks where code = 'LL-014'), (select id from tasks where code = 'LL-012')
union all
select (select id from tasks where code = 'LL-015'), (select id from tasks where code = 'LL-012')
union all
select (select id from tasks where code = 'LL-016'), (select id from tasks where code = 'LL-015')
union all
select (select id from tasks where code = 'LL-017'), (select id from tasks where code = 'LL-016')
union all
select (select id from tasks where code = 'LL-018'), (select id from tasks where code = 'LL-017')
union all
select (select id from tasks where code = 'LL-019'), (select id from tasks where code = 'LL-018')
union all
select (select id from tasks where code = 'LL-020'), (select id from tasks where code = 'LL-017')
union all
select (select id from tasks where code = 'LL-020'), (select id from tasks where code = 'LL-019')
union all
select (select id from tasks where code = 'LL-021'), (select id from tasks where code = 'LL-008')
union all
select (select id from tasks where code = 'LL-021'), (select id from tasks where code = 'LL-014')
union all
select (select id from tasks where code = 'LL-022'), (select id from tasks where code = 'LL-008')
union all
select (select id from tasks where code = 'LL-022'), (select id from tasks where code = 'LL-021')
union all
select (select id from tasks where code = 'LL-023'), (select id from tasks where code = 'LL-021')
union all
select (select id from tasks where code = 'LL-026'), (select id from tasks where code = 'LL-025')
union all
select (select id from tasks where code = 'LL-027'), (select id from tasks where code = 'LL-025')
union all
select (select id from tasks where code = 'LL-028'), (select id from tasks where code = 'LL-014')
union all
select (select id from tasks where code = 'LL-028'), (select id from tasks where code = 'LL-015')
union all
select (select id from tasks where code = 'LL-028'), (select id from tasks where code = 'LL-016')
union all
select (select id from tasks where code = 'LL-028'), (select id from tasks where code = 'LL-017')
union all
select (select id from tasks where code = 'LL-028'), (select id from tasks where code = 'LL-018')
union all
select (select id from tasks where code = 'LL-028'), (select id from tasks where code = 'LL-019')
union all
select (select id from tasks where code = 'LL-028'), (select id from tasks where code = 'LL-020')
union all
select (select id from tasks where code = 'LL-028'), (select id from tasks where code = 'LL-021')
union all
select (select id from tasks where code = 'LL-028'), (select id from tasks where code = 'LL-022')
union all
select (select id from tasks where code = 'LL-028'), (select id from tasks where code = 'LL-023')
union all
select (select id from tasks where code = 'LL-028'), (select id from tasks where code = 'LL-024')
union all
select (select id from tasks where code = 'LL-028'), (select id from tasks where code = 'LL-025')
union all
select (select id from tasks where code = 'LL-028'), (select id from tasks where code = 'LL-026')
union all
select (select id from tasks where code = 'LL-028'), (select id from tasks where code = 'LL-027')
union all
select (select id from tasks where code = 'LL-032'), (select id from tasks where code = 'LL-031')
union all
select (select id from tasks where code = 'LL-037'), (select id from tasks where code = 'LL-034')
union all
select (select id from tasks where code = 'LL-038'), (select id from tasks where code = 'LL-031')
union all
select (select id from tasks where code = 'LL-039'), (select id from tasks where code = 'LL-038')
union all
select (select id from tasks where code = 'LL-040'), (select id from tasks where code = 'LL-038')
union all
select (select id from tasks where code = 'LL-040'), (select id from tasks where code = 'LL-039')
union all
select (select id from tasks where code = 'LL-041'), (select id from tasks where code = 'LL-034')
union all
select (select id from tasks where code = 'LL-043'), (select id from tasks where code = 'LL-042')
union all
select (select id from tasks where code = 'LL-045'), (select id from tasks where code = 'LL-043')
union all
select (select id from tasks where code = 'LL-045'), (select id from tasks where code = 'LL-044')
union all
select (select id from tasks where code = 'LL-048'), (select id from tasks where code = 'LL-006')
union all
select (select id from tasks where code = 'LL-048'), (select id from tasks where code = 'LL-046')
union all
select (select id from tasks where code = 'LL-052'), (select id from tasks where code = 'LL-051')
union all
select (select id from tasks where code = 'LL-054'), (select id from tasks where code = 'LL-053')
union all
select (select id from tasks where code = 'LL-055'), (select id from tasks where code = 'LL-042')
union all
select (select id from tasks where code = 'LL-055'), (select id from tasks where code = 'LL-054')
union all
select (select id from tasks where code = 'LL-059'), (select id from tasks where code = 'LL-055')
union all
select (select id from tasks where code = 'LL-060'), (select id from tasks where code = 'LL-050')
union all
select (select id from tasks where code = 'LL-060'), (select id from tasks where code = 'LL-051')
union all
select (select id from tasks where code = 'LL-060'), (select id from tasks where code = 'LL-052')
union all
select (select id from tasks where code = 'LL-060'), (select id from tasks where code = 'LL-053')
union all
select (select id from tasks where code = 'LL-060'), (select id from tasks where code = 'LL-054')
union all
select (select id from tasks where code = 'LL-060'), (select id from tasks where code = 'LL-055')
union all
select (select id from tasks where code = 'LL-060'), (select id from tasks where code = 'LL-056')
union all
select (select id from tasks where code = 'LL-060'), (select id from tasks where code = 'LL-057')
union all
select (select id from tasks where code = 'LL-060'), (select id from tasks where code = 'LL-058')
union all
select (select id from tasks where code = 'LL-060'), (select id from tasks where code = 'LL-059')
union all
select (select id from tasks where code = 'LL-062'), (select id from tasks where code = 'LL-021')
union all
select (select id from tasks where code = 'LL-062'), (select id from tasks where code = 'LL-023')
union all
select (select id from tasks where code = 'LL-064'), (select id from tasks where code = 'LL-061')
union all
select (select id from tasks where code = 'LL-064'), (select id from tasks where code = 'LL-062')
union all
select (select id from tasks where code = 'LL-064'), (select id from tasks where code = 'LL-063')
union all
select (select id from tasks where code = 'LL-065'), (select id from tasks where code = 'LL-064')
union all
select (select id from tasks where code = 'LL-066'), (select id from tasks where code = 'LL-065')
union all
select (select id from tasks where code = 'LL-067'), (select id from tasks where code = 'LL-066')
on conflict do nothing;

-- Les 8 portes de lancement --------------------------------------
insert into launch_gates (position, label, owner_member_id, deadline, status, proof)
select 1, '1. Sign an owner', (select id from members where full_name = 'Greg'), '2026-09-27'::date, 'in_progress', 'Signed management agreement + onboarding date'
union all
select 2, '2. Onboard owner same day', (select id from members where full_name = 'Eliot'), '2026-09-27'::date, 'not_started', 'Fresh owner can begin onboarding immediately'
union all
select 3, '3. Portfolio data accurate', (select id from members where full_name = 'Steven'), '2026-09-27'::date, 'in_progress', 'Building/unit/tenant/lease data visible'
union all
select 4, '4. Tenant submits request', (select id from members where full_name = 'Steven'), '2026-09-27'::date, 'in_progress', 'Real tenant submits service request'
union all
select 5, '5. Lia triages correctly', (select id from members where full_name = 'Steven'), '2026-09-27'::date, 'in_progress', 'Urgency + trade + next action pass test'
union all
select 6, '6. Work tracked to invoice', (select id from members where full_name = 'Eliot'), '2026-09-27'::date, 'not_started', 'Dispatch→work→photos→invoice→closure'
union all
select 7, '7. Owner sees everything', (select id from members where full_name = 'Steven'), '2026-09-27'::date, 'not_started', 'Owner understands status/cost/history without calling'
union all
select 8, 'GO / NO-GO', (select id from members where full_name = 'Greg'), '2026-09-29'::date, 'not_started', 'All P0 blockers resolved or explicit 24h action plan'
on conflict do nothing;

-- Décisions ouvertes et risques actifs (12) ----------------------------
insert into decisions_risks (kind, topic, owner_label, due, status, resolution, impact, related_task_id)
select 'decision', 'Exact owner onboarding document pack', 'Greg / Eliot', '2026-09-08'::date, 'open', 'Finalize after first real onboarding test.', 'Slower onboarding / missing data', (select id from tasks where code = 'LL-031')
union all
select 'decision', 'Applicant screening / credit-check cost model', 'Greg', '2026-09-10'::date, 'open', 'Choose compliant owner-paid or recovery model.', 'Pricing ambiguity', (select id from tasks where code = 'LL-007')
union all
select 'decision', 'Rent collection / fund custody / reconciliation architecture', 'Greg / Steven', '2026-09-10'::date, 'open', 'Confirm banking/legal/accounting model before deep automation.', 'Financial/legal risk; wrong tech architecture', (select id from tasks where code = 'LL-008')
union all
select 'decision', 'Annual termination language', 'Greg / Lawyer', '2026-09-15'::date, 'open', 'Use market-standard annual agreement; lawyer validates cancellation mechanics.', 'Contract unenforceability / sales friction', (select id from tasks where code = 'LL-006')
union all
select 'decision', 'Day-1 geographical coverage', 'Eliot', '2026-09-12'::date, 'open', 'Match sales coverage to actual vendor network.', 'Service failure outside coverage', (select id from tasks where code = 'LL-041')
union all
select 'decision', 'Lia voice: launch vs immediate post-launch', 'Greg / Steven', '2026-09-25'::date, 'open', 'Do not block launch unless call intake is critical to chosen operating model.', 'Scope creep', (select id from tasks where code = 'LL-029')
union all
select 'risk', 'Platform critical path not fully known', 'Steven', '2026-09-07'::date, 'active', 'Finish traffic-light audit and demo every step.', 'Launch delay', (select id from tasks where code = 'LL-012')
union all
select 'risk', 'Too much operational knowledge remains with Greg', 'Eliot', '2026-09-21'::date, 'active', 'Greg teaches; Eliot executes/document; run pilot without Greg doing work.', 'Founder bottleneck', (select id from tasks where code = 'LL-040')
union all
select 'risk', 'Vendor network insufficient for automated dispatch', 'Eliot', '2026-09-12'::date, 'active', 'Build backups by trade; start Québec first.', 'Poor emergency response', (select id from tasks where code = 'LL-034')
union all
select 'risk', 'Meta spend before funnel/tracking works', 'Andy', '2026-09-15'::date, 'active', 'No paid scale until test lead reaches CRM and assigned owner.', 'Wasted ad spend', (select id from tasks where code = 'LL-059')
union all
select 'risk', 'No CRM causes missed follow-up', 'Xav', '2026-09-06'::date, 'active', 'Select simple CRM now; no custom build.', 'Lost prospects', (select id from tasks where code = 'LL-042')
union all
select 'risk', 'Silent automation failures', 'Steven', '2026-09-22'::date, 'active', 'Exception queue + alerts + human fallback.', 'Customer issues invisible', (select id from tasks where code = 'LL-027')
on conflict do nothing;

-- Ordre du jour de la réunion du dimanche (7 blocs, 45 min) ---------
insert into meeting_agenda (position, time_slot, owner_label, section, required_output)
select 1, '0–5 min', 'Greg', 'Company snapshot', 'Doors signed/onboarding, biggest blocker, decisions needed'
union all
select 2, '5–12 min', 'Xav', 'Sales', 'Prospects, meetings, proposals, doors, next follow-ups'
union all
select 3, '12–19 min', 'Andy', 'Marketing', 'Qualified leads, CPL, meetings, funnel/campaign status'
union all
select 4, '19–26 min', 'Eliot', 'Operations', 'Onboardings, tickets, vendors, delays, quality issues'
union all
select 5, '26–33 min', 'Steven', 'Technology', 'P0 opened/closed, critical bugs, automation failures, path %'
union all
select 6, '33–40 min', 'All', 'Decisions', 'Every cross-team issue exits with one owner + deadline'
union all
select 7, '40–45 min', 'Greg', '3 priorities each', 'Maximum 3 critical priorities per person for next 7 days'
on conflict do nothing;

-- KPI hebdomadaires suivis en réunion (15) ---------------------------
insert into kpi_definitions (position, member_id, name, definition)
select 1, (select id from members where full_name = 'Greg'), 'Doors signed', 'Launch goal tracks toward ~100 doors'
union all
select 2, (select id from members where full_name = 'Greg'), 'MRR signed', '6% of contracted rent base'
union all
select 3, (select id from members where full_name = 'Greg'), 'Active proposals', 'Count of live proposals'
union all
select 4, (select id from members where full_name = 'Xav'), 'Qualified prospects', 'Owner + doors + region + fit confirmed'
union all
select 5, (select id from members where full_name = 'Xav'), 'Meetings held', 'Real owner meetings completed'
union all
select 6, (select id from members where full_name = 'Xav'), 'Proposal conversion', 'Meetings progressing to proposal'
union all
select 7, (select id from members where full_name = 'Andy'), 'Qualified leads', 'Owner lead meeting minimum qualification'
union all
select 8, (select id from members where full_name = 'Andy'), 'Cost / qualified lead', 'Ad spend ÷ qualified leads'
union all
select 9, (select id from members where full_name = 'Andy'), 'Marketing meetings', 'Meetings sourced by marketing'
union all
select 10, (select id from members where full_name = 'Eliot'), 'Doors onboarded', 'Doors fully active in Lease Lane'
union all
select 11, (select id from members where full_name = 'Eliot'), 'Resolution time', 'Average request → closure time'
union all
select 12, (select id from members where full_name = 'Eliot'), 'Active vendors', 'Vendors able to accept work'
union all
select 13, (select id from members where full_name = 'Steven'), 'P0 open', 'Must trend to zero by go/no-go'
union all
select 14, (select id from members where full_name = 'Steven'), 'P0 closed', 'Critical bugs/features closed in week'
union all
select 15, (select id from members where full_name = 'Steven'), 'Critical path %', '% launch path passing end-to-end test'
on conflict do nothing;

-- Trace de l'amorçage dans le journal --------------------------------
insert into activity_log (entity_type, actor_kind, action, summary, details)
select 'board', 'system', 'board_imported',
       'Master Task Board importé : 67 tâches, 8 portes, 12 décisions/risques, 15 KPI.',
       jsonb_build_object('source', 'LeaseLane_Master_Task_Board.xlsx', 'imported_on', '2026-09-04')
where not exists (select 1 from activity_log where action = 'board_imported');
