-- =====================================================================
-- LEASE LANE COMMAND CENTER — fonctions d'accès, triggers, vues, RLS
--
-- Principe d'accès retenu (« le plus simple possible pour l'équipe ») :
--   • Connexion Google en un clic. Aucun mot de passe à retenir, aucune
--     invitation à accepter.
--   • À la première connexion, le compte est rattaché automatiquement à
--     la personne dont l'adresse figure dans member_emails. Une adresse
--     inconnue n'obtient AUCUN accès (aucune ligne members → RLS bloque
--     tout) : la porte est fermée par défaut, pas par oubli.
--   • Tout membre actif voit tout le tableau et peut tout y modifier —
--     c'est un tableau d'équipe de 5 personnes, pas un ERP. Seules les
--     suppressions et les réglages sensibles sont réservés aux admins.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Fonctions d'identité (security definer : elles lisent members, qui est
-- elle-même protégée par RLS — sans ça, récursion infinie de policy)
-- ---------------------------------------------------------------------

create or replace function cc_member_id()
returns uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select id from members where user_id = auth.uid() and is_active limit 1;
$$;

create or replace function cc_is_member()
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from members where user_id = auth.uid() and is_active);
$$;

create or replace function cc_is_admin()
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from members where user_id = auth.uid() and is_active and is_admin);
$$;

create or replace function cc_setting(p_key text, p_default jsonb default 'null'::jsonb)
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce((select value from app_settings where key = p_key), p_default);
$$;

-- Un membre voit-il le contenu de la boîte d'un compte Google donné ?
-- Réglage `mailbox_visibility` : 'all' (défaut — équipe de 5, tout le
-- monde voit tout, ce qui est demandé) ou 'own' (chacun sa boîte ; les
-- résumés IA restent partagés dans tous les cas via les vues).
create or replace function cc_can_read_account(p_account_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select cc_is_member() and (
    cc_setting('mailbox_visibility', '"all"'::jsonb) = '"all"'::jsonb
    or cc_is_admin()
    or exists (
      select 1 from google_accounts ga
      where ga.id = p_account_id and ga.member_id = cc_member_id()
    )
  );
$$;

-- ---------------------------------------------------------------------
-- Rattachement automatique du compte à la connexion
-- ---------------------------------------------------------------------

-- Déclenché quand quelqu'un se connecte pour la première fois avec
-- Google : si son adresse est déclarée dans member_emails, le compte
-- auth est relié à la bonne personne. Sinon rien ne se passe — pas
-- d'erreur bruyante côté Google, mais aucun accès non plus.
create or replace function cc_link_auth_user()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_member_id uuid;
begin
  select me.member_id into v_member_id
  from member_emails me
  where me.email = new.email
  limit 1;

  if v_member_id is not null then
    update members
       set user_id   = new.id,
           avatar_url = coalesce(members.avatar_url, new.raw_user_meta_data ->> 'avatar_url')
     where id = v_member_id
       and (user_id is null or user_id = new.id);

    insert into activity_log (entity_type, entity_id, actor_kind, member_id, action, summary)
    values ('member', v_member_id, 'system', v_member_id, 'signed_in_first_time',
            'Compte Google ' || new.email || ' rattaché automatiquement.');
  else
    insert into activity_log (entity_type, actor_kind, action, summary, details)
    values ('member', 'system', 'unknown_signin_blocked',
            'Connexion refusée : adresse non déclarée dans l''équipe.',
            jsonb_build_object('email', new.email));
  end if;

  return new;
end;
$$;

drop trigger if exists cc_link_auth_user_trg on auth.users;
create trigger cc_link_auth_user_trg
after insert on auth.users
for each row execute function cc_link_auth_user();

-- Même logique quand une adresse est ajoutée APRÈS que la personne se
-- soit déjà connectée une fois (ex. Greg ajoute l'adresse Lease Lane de
-- Xav alors que Xav avait déjà essayé de se connecter).
create or replace function cc_link_existing_auth_user()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
begin
  select u.id into v_user_id from auth.users u where u.email = new.email limit 1;
  if v_user_id is not null then
    update members set user_id = v_user_id
     where id = new.member_id and user_id is null;
  end if;
  return new;
end;
$$;

drop trigger if exists cc_link_existing_auth_user_trg on member_emails;
create trigger cc_link_existing_auth_user_trg
after insert on member_emails
for each row execute function cc_link_existing_auth_user();

-- ---------------------------------------------------------------------
-- Traçabilité automatique des tâches (qui a changé quoi, quand)
-- ---------------------------------------------------------------------

create or replace function cc_touch_task()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_member uuid := cc_member_id();
begin
  new.updated_at := now();
  if v_member is not null then
    new.updated_by := v_member;
  end if;

  -- Une tâche « done » enregistre sa date de complétion une seule fois ;
  -- la rouvrir la remet à zéro (sinon les KPI comptent des faux positifs).
  if new.status = 'done' and coalesce(old.status, '') <> 'done' then
    new.completed_at := now();
    new.pct_complete := 1;
  elsif new.status <> 'done' and coalesce(old.status, '') = 'done' then
    new.completed_at := null;
  end if;

  if old.status is distinct from new.status then
    insert into activity_log (entity_type, entity_id, actor_kind, member_id, action, summary, details)
    values ('task', new.id, case when v_member is null then 'system' else 'human' end, v_member,
            'status_changed',
            coalesce(new.code, '') || ' : ' || old.status || ' → ' || new.status,
            jsonb_build_object('from', old.status, 'to', new.status));
  end if;

  if old.owner_member_id is distinct from new.owner_member_id then
    insert into activity_log (entity_type, entity_id, actor_kind, member_id, action, summary, details)
    values ('task', new.id, case when v_member is null then 'system' else 'human' end, v_member,
            'owner_changed', coalesce(new.code, '') || ' : responsable modifié',
            jsonb_build_object('from', old.owner_member_id, 'to', new.owner_member_id));
  end if;

  if old.deadline is distinct from new.deadline then
    insert into activity_log (entity_type, entity_id, actor_kind, member_id, action, summary, details)
    values ('task', new.id, case when v_member is null then 'system' else 'human' end, v_member,
            'deadline_changed', coalesce(new.code, '') || ' : échéance modifiée',
            jsonb_build_object('from', old.deadline, 'to', new.deadline));
  end if;

  return new;
end;
$$;

drop trigger if exists cc_touch_task_trg on tasks;
create trigger cc_touch_task_trg
before update on tasks
for each row execute function cc_touch_task();

create or replace function cc_touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists cc_touch_gates_trg on launch_gates;
create trigger cc_touch_gates_trg before update on launch_gates
for each row execute function cc_touch_updated_at();

drop trigger if exists cc_touch_decisions_trg on decisions_risks;
create trigger cc_touch_decisions_trg before update on decisions_risks
for each row execute function cc_touch_updated_at();

-- ---------------------------------------------------------------------
-- Vues : ce que l'interface lit directement (état calculé, jamais stocké)
-- ---------------------------------------------------------------------

-- « Santé » d'une tâche — calculée à la lecture, donc toujours juste,
-- contrairement à la colonne figée du fichier Excel qui devenait fausse
-- dès le lendemain.
create or replace function cc_task_health(p_status text, p_deadline date)
returns text
language sql stable
set search_path = public, pg_temp
as $$
  select case
    when p_status = 'done'                                    then 'done'
    when p_status = 'blocked'                                 then 'blocked'
    when p_deadline is null                                   then 'ok'
    when p_deadline < current_date                            then 'late'
    when p_status = 'at_risk'                                 then 'at_risk'
    when p_deadline - current_date <= 3                       then 'due_soon'
    else 'ok'
  end;
$$;

drop view if exists v_tasks;
create view v_tasks as
select
  t.*,
  m.full_name  as owner_name,
  m.avatar_url as owner_avatar,
  (t.deadline - current_date)             as days_left,
  cc_task_health(t.status, t.deadline)    as health,
  (select count(*) from task_comments c where c.task_id = t.id)            as comment_count,
  (select count(*) from task_dependencies d where d.task_id = t.id)        as dependency_count,
  (select count(*) from task_dependencies d
     join tasks bt on bt.id = d.depends_on_id
    where d.task_id = t.id and bt.status <> 'done')                        as blocking_count
from tasks t
left join members m on m.id = t.owner_member_id;

-- Compteurs par personne, tels qu'affichés en haut du tableau.
drop view if exists v_owner_summary;
create view v_owner_summary as
select
  m.id            as member_id,
  m.full_name,
  m.role_label,
  m.position,
  count(t.id) filter (where t.priority = 'p0' and t.status <> 'done')  as open_p0,
  count(t.id) filter (where t.status <> 'done')                        as open_all,
  count(t.id) filter (where t.priority = 'p0' and t.status = 'done')   as done_p0,
  count(t.id) filter (where t.status = 'blocked')                      as blocked,
  count(t.id) filter (where t.status <> 'done' and t.deadline < current_date) as late,
  count(t.id)                                                          as total
from members m
left join tasks t on t.owner_member_id = m.id
where m.is_active
group by m.id, m.full_name, m.role_label, m.position;

-- Le bandeau du haut : jours avant lancement, % d'avancement P0, etc.
drop view if exists v_dashboard;
create view v_dashboard as
select
  (cc_setting('launch_date', '"2026-10-01"'::jsonb) #>> '{}')::date            as launch_date,
  ((cc_setting('launch_date', '"2026-10-01"'::jsonb) #>> '{}')::date - current_date) as days_to_launch,
  count(*)                                                                     as total_tasks,
  count(*) filter (where priority = 'p0')                                      as p0_total,
  count(*) filter (where priority = 'p0' and status = 'done')                  as p0_done,
  count(*) filter (where priority = 'p0' and status <> 'done')                 as p0_open,
  count(*) filter (where status = 'blocked')                                   as blocked,
  count(*) filter (where status <> 'done' and deadline < current_date)         as late,
  count(*) filter (where status <> 'done' and deadline - current_date between 0 and 3) as due_soon,
  round(
    coalesce(count(*) filter (where priority = 'p0' and status = 'done')::numeric
             / nullif(count(*) filter (where priority = 'p0'), 0), 0) * 100, 1) as p0_completion_pct,
  round(
    coalesce(count(*) filter (where status = 'done')::numeric
             / nullif(count(*), 0), 0) * 100, 1)                                as overall_completion_pct
from tasks;

-- Résumés IA des courriels, visibles par toute l'équipe même quand le
-- corps du message ne l'est pas (réglage mailbox_visibility = 'own').
-- Vue-écran sur google_accounts : expose l'identité d'un compte (à quelle
-- personne il appartient, quelle adresse) et JAMAIS les jetons. Elle est
-- en security definer (security_invoker = off) pour deux raisons :
--   • google_accounts n'accorde aucune permission à `authenticated`, donc
--     une vue en invoker qui la traverse serait refusée en bloc — c'est ce
--     qui cassait v_email_digest et v_agenda ;
--   • google_accounts a le RLS actif sans aucune policy : en invoker, la
--     jointure ne ramènerait de toute façon aucune ligne.
-- Les colonnes de jetons sont absentes du select : il n'y a rien à fuir.
--
-- Mais contourner le RLS veut aussi dire qu'AUCUN filtre ne s'applique
-- tout seul : sans le `where` ci-dessous, n'importe quel compte Google
-- connecté — y compris un inconnu sans ligne members — pourrait lister
-- les adresses de l'équipe. Le contrôle d'appartenance est donc écrit
-- explicitement dans la vue, puisqu'il ne peut pas venir du RLS.
drop view if exists v_google_accounts_public cascade;
create view v_google_accounts_public
  with (security_invoker = off) as
select ga.id, ga.member_id, ga.google_email, ga.status, ga.last_sync_at,
       m.full_name as owner_name
from google_accounts ga
join members m on m.id = ga.member_id
where cc_is_member();

drop view if exists v_email_digest;
create view v_email_digest as
select
  e.id, e.google_account_id, ga.google_email as account_email, ga.owner_name as account_owner,
  e.thread_id, e.from_email, e.from_name, e.subject, e.received_at, e.is_unread,
  e.has_attachments, e.ai_status, e.ai_category, e.ai_urgency, e.ai_summary, e.ai_action,
  e.ai_entities, e.task_id,
  case when cc_can_read_account(e.google_account_id) then e.snippet end   as snippet,
  case when cc_can_read_account(e.google_account_id) then e.body_text end as body_text
from email_messages e
join v_google_accounts_public ga on ga.id = e.google_account_id;

-- Agenda unifié des 4 comptes — la vue « qui fait quoi cette semaine ».
drop view if exists v_agenda;
create view v_agenda as
select
  c.id, c.google_account_id, ga.google_email as account_email, ga.owner_name as account_owner,
  ga.member_id, c.title, c.location, c.starts_at, c.ends_at, c.all_day,
  c.attendees, c.organizer_email, c.status, c.html_link, c.origin, c.task_id,
  t.code as task_code
from calendar_events c
join v_google_accounts_public ga on ga.id = c.google_account_id
left join tasks t on t.id = c.task_id
where c.status <> 'cancelled';

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------

alter table members            enable row level security;
alter table member_emails      enable row level security;
alter table google_accounts    enable row level security;
alter table tasks              enable row level security;
alter table task_dependencies  enable row level security;
alter table task_comments      enable row level security;
alter table launch_gates       enable row level security;
alter table decisions_risks    enable row level security;
alter table meeting_agenda     enable row level security;
alter table meetings           enable row level security;
alter table meeting_priorities enable row level security;
alter table kpi_definitions    enable row level security;
alter table kpi_values         enable row level security;
alter table email_messages     enable row level security;
alter table calendar_events    enable row level security;
alter table documents          enable row level security;
alter table sync_state         enable row level security;
alter table automation_policies enable row level security;
alter table ai_suggestions     enable row level security;
alter table ai_run_log         enable row level security;
alter table activity_log       enable row level security;
alter table notifications      enable row level security;
alter table app_settings       enable row level security;

-- Tables collaboratives : tout membre actif lit et écrit ; seul un admin
-- supprime. Les policies sont recréées à chaque exécution (drop d'abord)
-- pour que le fichier reste rejouable.
do $$
declare
  t text;
  collab text[] := array[
    'tasks','task_dependencies','task_comments','launch_gates','decisions_risks',
    'meetings','meeting_priorities','kpi_definitions','kpi_values'
  ];
begin
  foreach t in array collab loop
    execute format('drop policy if exists cc_read on %I',   t);
    execute format('drop policy if exists cc_insert on %I', t);
    execute format('drop policy if exists cc_update on %I', t);
    execute format('drop policy if exists cc_delete on %I', t);
    execute format('create policy cc_read   on %I for select using (cc_is_member())', t);
    execute format('create policy cc_insert on %I for insert with check (cc_is_member())', t);
    execute format('create policy cc_update on %I for update using (cc_is_member()) with check (cc_is_member())', t);
    execute format('create policy cc_delete on %I for delete using (cc_is_admin())', t);
  end loop;
end $$;

-- Lecture seule pour tous les membres, écriture réservée aux admins.
do $$
declare
  t text;
  readonly text[] := array['members','member_emails','meeting_agenda','app_settings','automation_policies'];
begin
  foreach t in array readonly loop
    execute format('drop policy if exists cc_read on %I',        t);
    execute format('drop policy if exists cc_admin_write on %I', t);
    execute format('create policy cc_read on %I for select using (cc_is_member())', t);
    execute format('create policy cc_admin_write on %I for all using (cc_is_admin()) with check (cc_is_admin())', t);
  end loop;
end $$;

-- Journaux : lecture pour l'équipe, écriture uniquement par le serveur
-- (edge functions en service_role) — personne ne réécrit l'historique.
drop policy if exists cc_read on activity_log;
create policy cc_read on activity_log for select using (cc_is_member());
drop policy if exists cc_read on ai_run_log;
create policy cc_read on ai_run_log for select using (cc_is_member());

-- Suggestions IA : l'équipe les voit et les décide (approuver/refuser) ;
-- seul le serveur en crée et les marque « appliquée ».
drop policy if exists cc_read on ai_suggestions;
create policy cc_read on ai_suggestions for select using (cc_is_member());
-- Volontairement PAS de policy d'écriture : approuver ou refuser passe par
-- l'edge function cc-apply-suggestion, qui décide ET exécute dans la foulée.
-- Autoriser un update direct depuis le navigateur créerait des suggestions
-- « approuvées » que rien n'appliquerait jamais.

-- Notifications : chacun voit et marque comme lues les siennes.
drop policy if exists cc_own on notifications;
create policy cc_own on notifications for select
  using (member_id is null or member_id = cc_member_id());
drop policy if exists cc_own_update on notifications;
create policy cc_own_update on notifications for update
  using (member_id = cc_member_id()) with check (member_id = cc_member_id());

-- Contenu Google : lisible selon le réglage mailbox_visibility, jamais
-- modifiable depuis le navigateur (la source de vérité est Google, la
-- synchro passe par les edge functions en service_role).
drop policy if exists cc_read on email_messages;
create policy cc_read on email_messages for select
  using (cc_can_read_account(google_account_id));
drop policy if exists cc_read on documents;
create policy cc_read on documents for select
  using ((google_account_id is null and cc_is_member()) or cc_can_read_account(google_account_id));
drop policy if exists cc_read on calendar_events;
create policy cc_read on calendar_events for select using (cc_is_member());

-- google_accounts et sync_state : RLS activé, AUCUNE policy. Verrouillées
-- au service_role. Les jetons Google ne sont jamais lisibles depuis le
-- navigateur, même par un admin — l'interface passe par cc-board-api pour
-- connaître l'état des connexions (statut, dernière synchro), jamais les
-- jetons eux-mêmes. Même convention que les tables sensibles du Portail.

-- Les vues s'exécutent avec les droits de l'appelant (Postgres 15+),
-- donc les RLS ci-dessus s'appliquent aussi à travers elles.
alter view v_tasks          set (security_invoker = on);
alter view v_owner_summary  set (security_invoker = on);
alter view v_dashboard      set (security_invoker = on);
alter view v_email_digest   set (security_invoker = on);
alter view v_agenda         set (security_invoker = on);

-- ---------------------------------------------------------------------
-- Temps réel : l'interface reçoit les changements sans rafraîchir
-- ---------------------------------------------------------------------
do $$
declare
  t text;
  live text[] := array[
    'tasks','task_comments','launch_gates','decisions_risks','ai_suggestions',
    'email_messages','calendar_events','documents','activity_log','notifications',
    'meetings','meeting_priorities','kpi_values','members'
  ];
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array live loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end $$;

-- Les mises à jour temps réel doivent transporter l'ancienne valeur pour
-- que l'interface sache ce qui a changé (sinon `old` arrive vide).
alter table tasks           replica identity full;
alter table ai_suggestions  replica identity full;
alter table launch_gates    replica identity full;
alter table decisions_risks replica identity full;

-- ---------------------------------------------------------------------
-- Permissions explicites
--
-- Le RLS décide QUELLES LIGNES sont visibles ; les GRANT décident quelles
-- TABLES sont atteignables. Ce sont deux barrières distinctes, et le
-- projet ne doit pas dépendre du réglage « Automatically expose new
-- tables » de Supabase (qui accorde tout par défaut aux rôles de l'API).
--
-- Déclarer les droits ici permet de laisser ce réglage DÉSACTIVÉ — la
-- recommandation de Supabase — sans rien casser : une table ajoutée plus
-- tard sans y penser reste alors inatteignable depuis le navigateur au
-- lieu d'être silencieusement exposée.
--
-- `anon` (visiteur non connecté) n'obtient RIEN : l'écran de connexion ne
-- lit aucune donnée avant l'authentification.
-- ---------------------------------------------------------------------

grant usage on schema public to authenticated, service_role;

-- Le serveur (edge functions) garde l'accès complet ; il contourne le RLS
-- par son rôle, c'est ce qui lui permet de synchroniser Google.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

do $$
declare
  t text;
  -- Le tableau de travail : l'équipe lit et écrit, le RLS réserve la
  -- suppression aux admins.
  full_access text[] := array[
    'tasks','task_dependencies','task_comments','launch_gates','decisions_risks',
    'meetings','meeting_priorities','kpi_definitions','kpi_values'
  ];
  -- Configuration : le RLS réserve déjà l'écriture aux admins.
  config text[] := array['members','member_emails','meeting_agenda','app_settings','automation_policies'];
  -- Données produites par le serveur : lecture seule côté navigateur. La
  -- source de vérité est Google ou l'IA, jamais un formulaire.
  read_only text[] := array[
    'email_messages','calendar_events','documents','ai_suggestions','ai_run_log','activity_log'
  ];
begin
  foreach t in array full_access loop
    execute format('grant select, insert, update, delete on %I to authenticated', t);
  end loop;
  foreach t in array config loop
    execute format('grant select, insert, update, delete on %I to authenticated', t);
  end loop;
  foreach t in array read_only loop
    execute format('grant select on %I to authenticated', t);
  end loop;

  -- Chacun marque ses propres notifications comme lues.
  execute 'grant select, update on notifications to authenticated';
end $$;

-- google_accounts et sync_state : AUCUN grant, volontairement. Ces tables
-- contiennent les jetons Google. Ni policy RLS ni permission — seul le
-- service_role les atteint. C'est la deuxième barrière derrière le
-- chiffrement AES-GCM des jetons.

-- Les vues s'exécutent avec les droits de l'appelant (security_invoker),
-- donc lire une vue exige aussi le droit sur les tables qu'elle traverse.
grant select on v_tasks, v_owner_summary, v_dashboard, v_email_digest, v_agenda,
                v_google_accounts_public to authenticated;
