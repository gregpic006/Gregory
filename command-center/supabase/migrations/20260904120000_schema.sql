-- =====================================================================
-- LEASE LANE COMMAND CENTER — schéma initial
--
-- Projet à part entière : sa PROPRE base Supabase, distincte de celle du
-- Portail (gestion immobilière). Aucune table, aucune fonction et aucun
-- secret n'est partagé entre les deux. Voir command-center/README.md.
--
-- Contenu : le Master Task Board (67 tâches, 8 portes de lancement,
-- 12 décisions/risques, 15 KPI), les 4 comptes Google connectés, et ce
-- que l'IA en tire (courriels triés, documents lus, agenda organisé).
--
-- Tout est idempotent (`if not exists`) — le fichier reste rejouable.
-- =====================================================================

create extension if not exists pgcrypto;
create extension if not exists citext;

-- ---------------------------------------------------------------------
-- 1. Identité — qui est sur le tableau, et avec quel compte Google
-- ---------------------------------------------------------------------

-- Une ligne par personne de l'équipe Lease Lane. `user_id` est rempli
-- automatiquement à la première connexion Google (voir le trigger
-- cc_link_auth_user plus bas) : personne n'a de manipulation à faire.
create table if not exists members (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid unique references auth.users(id) on delete set null,
  full_name     text not null unique,
  role_label    text,
  is_admin      boolean not null default false,
  is_active     boolean not null default true,
  avatar_url    text,
  position      integer not null default 100,
  created_at    timestamptz not null default now()
);

-- Une personne peut avoir plusieurs adresses (compte Lease Lane +
-- adresse personnelle). N'importe laquelle ouvre la porte du tableau.
create table if not exists member_emails (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references members(id) on delete cascade,
  email       citext not null unique,
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists member_emails_member_idx on member_emails(member_id);

-- Les comptes Google connectés (les 4 comptes Lease Lane). Les jetons
-- sont chiffrés au niveau applicatif (AES-GCM, clé CC_TOKEN_KEY) EN PLUS
-- d'être dans une table verrouillée service_role — un dump de la base ne
-- suffit donc pas à accéder aux boîtes courriel.
create table if not exists google_accounts (
  id                   uuid primary key default gen_random_uuid(),
  member_id            uuid not null references members(id) on delete cascade,
  google_email         citext not null unique,
  refresh_token_enc    text,
  access_token_enc     text,
  access_token_expires timestamptz,
  granted_scopes       text[] not null default '{}',
  status               text not null default 'active'
                       check (status in ('active','needs_reauth','disabled')),
  last_sync_at         timestamptz,
  last_error           text,
  connected_at         timestamptz not null default now()
);
create index if not exists google_accounts_member_idx on google_accounts(member_id);

-- ---------------------------------------------------------------------
-- 2. Le tableau lui-même
-- ---------------------------------------------------------------------

create table if not exists tasks (
  id                uuid primary key default gen_random_uuid(),
  code              text unique,                       -- LL-001, LL-002…
  workstream        text not null default 'Governance',
  title             text not null,
  description       text,
  owner_member_id   uuid references members(id) on delete set null,
  priority          text not null default 'p0'
                    check (priority in ('p0','p1','p2')),
  is_critical       boolean not null default false,
  start_date        date,
  deadline          date,
  status            text not null default 'not_started'
                    check (status in ('not_started','in_progress','waiting','blocked','at_risk','done')),
  pct_complete      numeric(4,3) not null default 0
                    check (pct_complete >= 0 and pct_complete <= 1),
  dependency_note   text,
  definition_of_done text,
  notes             text,
  source            text not null default 'manual'
                    check (source in ('board_import','manual','ai')),
  created_by        uuid references members(id) on delete set null,
  updated_by        uuid references members(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz
);
create index if not exists tasks_owner_idx     on tasks(owner_member_id);
create index if not exists tasks_status_idx    on tasks(status);
create index if not exists tasks_deadline_idx  on tasks(deadline);
create index if not exists tasks_priority_idx  on tasks(priority);

-- Dépendances réelles (LL-005 dépend de LL-004). Le texte libre de la
-- colonne « Dependency » du fichier Excel reste dans dependency_note ;
-- ce qui est résolvable en code de tâche est aussi normalisé ici.
create table if not exists task_dependencies (
  task_id       uuid not null references tasks(id) on delete cascade,
  depends_on_id uuid not null references tasks(id) on delete cascade,
  primary key (task_id, depends_on_id),
  check (task_id <> depends_on_id)
);

create table if not exists task_comments (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references tasks(id) on delete cascade,
  member_id  uuid references members(id) on delete set null,
  author_kind text not null default 'human' check (author_kind in ('human','ai','system')),
  body       text not null,
  created_at timestamptz not null default now()
);
create index if not exists task_comments_task_idx on task_comments(task_id, created_at desc);

-- Les 7 portes de lancement + le GO/NO-GO de l'onglet Dashboard.
create table if not exists launch_gates (
  id              uuid primary key default gen_random_uuid(),
  position        integer not null unique,
  label           text not null,
  owner_member_id uuid references members(id) on delete set null,
  deadline        date,
  status          text not null default 'not_started'
                  check (status in ('not_started','in_progress','waiting','blocked','at_risk','done')),
  proof           text,
  notes           text,
  updated_at      timestamptz not null default now()
);

create table if not exists decisions_risks (
  id                uuid primary key default gen_random_uuid(),
  kind              text not null check (kind in ('decision','risk')),
  topic             text not null,
  unique (kind, topic),
  owner_label       text,
  owner_member_id   uuid references members(id) on delete set null,
  due               date,
  status            text not null default 'open'
                    check (status in ('open','active','resolved','closed')),
  resolution        text,
  impact            text,
  related_task_id   uuid references tasks(id) on delete set null,
  updated_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3. Réunion du dimanche (45 min) + KPI hebdomadaires
-- ---------------------------------------------------------------------

create table if not exists meeting_agenda (
  id            uuid primary key default gen_random_uuid(),
  position      integer not null unique,
  time_slot     text not null,
  owner_label   text,
  section       text not null,
  required_output text
);

create table if not exists meetings (
  id          uuid primary key default gen_random_uuid(),
  meets_on    date not null unique,
  status      text not null default 'planned' check (status in ('planned','held','skipped')),
  notes       text,
  brief       text,                       -- préparé automatiquement par l'IA
  brief_at    timestamptz,
  calendar_event_id uuid,
  created_at  timestamptz not null default now()
);

create table if not exists meeting_priorities (
  id         uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references meetings(id) on delete cascade,
  member_id  uuid references members(id) on delete cascade,
  rank       integer not null check (rank between 1 and 3),
  label      text not null,
  task_id    uuid references tasks(id) on delete set null,
  blocker    text,
  unique (meeting_id, member_id, rank)
);

create table if not exists kpi_definitions (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid references members(id) on delete set null,
  name        text not null,
  definition  text,
  position    integer not null unique
);

create table if not exists kpi_values (
  id        uuid primary key default gen_random_uuid(),
  kpi_id    uuid not null references kpi_definitions(id) on delete cascade,
  week_of   date not null,
  value     numeric,
  note      text,
  updated_at timestamptz not null default now(),
  unique (kpi_id, week_of)
);

-- ---------------------------------------------------------------------
-- 4. Ce que les comptes Google apportent : courriels, agenda, documents
-- ---------------------------------------------------------------------

create table if not exists email_messages (
  id               uuid primary key default gen_random_uuid(),
  google_account_id uuid not null references google_accounts(id) on delete cascade,
  gmail_id         text not null,
  thread_id        text,
  from_email       citext,
  from_name        text,
  to_emails        text[] not null default '{}',
  cc_emails        text[] not null default '{}',
  subject          text,
  snippet          text,
  body_text        text,
  received_at      timestamptz,
  is_unread        boolean not null default false,
  has_attachments  boolean not null default false,
  gmail_labels     text[] not null default '{}',
  ai_status        text not null default 'pending'
                   check (ai_status in ('pending','processing','done','error','skipped')),
  ai_category      text,
  ai_urgency       text check (ai_urgency in ('urgent','high','normal','low')),
  ai_summary       text,
  ai_action        text,
  ai_entities      jsonb not null default '{}'::jsonb,
  task_id          uuid references tasks(id) on delete set null,
  processed_at     timestamptz,
  created_at       timestamptz not null default now(),
  unique (google_account_id, gmail_id)
);
create index if not exists email_messages_received_idx on email_messages(received_at desc);
create index if not exists email_messages_ai_status_idx on email_messages(ai_status) where ai_status = 'pending';

create table if not exists calendar_events (
  id                uuid primary key default gen_random_uuid(),
  google_account_id uuid not null references google_accounts(id) on delete cascade,
  google_event_id   text not null,
  calendar_id       text not null default 'primary',
  title             text,
  description       text,
  location          text,
  starts_at         timestamptz,
  ends_at           timestamptz,
  all_day           boolean not null default false,
  attendees         jsonb not null default '[]'::jsonb,
  organizer_email   citext,
  status            text not null default 'confirmed',
  html_link         text,
  origin            text not null default 'google'
                    check (origin in ('google','command_center')),
  task_id           uuid references tasks(id) on delete set null,
  updated_at        timestamptz not null default now(),
  unique (google_account_id, calendar_id, google_event_id)
);
create index if not exists calendar_events_start_idx on calendar_events(starts_at);

create table if not exists documents (
  id                uuid primary key default gen_random_uuid(),
  google_account_id uuid references google_accounts(id) on delete cascade,
  origin            text not null default 'drive'
                    check (origin in ('drive','gmail_attachment','upload')),
  source_ref        text not null,          -- id Drive, ou <gmail_id>:<attachment_id>
  name              text not null,
  mime_type         text,
  size_bytes        bigint,
  web_view_link     text,
  modified_at       timestamptz,
  text_excerpt      text,
  ai_status         text not null default 'pending'
                    check (ai_status in ('pending','processing','done','error','skipped')),
  ai_doc_type       text,
  ai_summary        text,
  ai_extracted      jsonb not null default '{}'::jsonb,
  task_id           uuid references tasks(id) on delete set null,
  processed_at      timestamptz,
  created_at        timestamptz not null default now(),
  unique (google_account_id, origin, source_ref)
);
create index if not exists documents_ai_status_idx on documents(ai_status) where ai_status = 'pending';

-- Curseur de synchronisation par compte et par source (historyId Gmail,
-- syncToken Calendar, pageToken Drive). Sans ça chaque passe relirait
-- toute la boîte.
create table if not exists sync_state (
  id                uuid primary key default gen_random_uuid(),
  google_account_id uuid not null references google_accounts(id) on delete cascade,
  source            text not null check (source in ('gmail','calendar','drive')),
  cursor            text,
  last_run_at       timestamptz,
  last_ok_at        timestamptz,
  last_error        text,
  unique (google_account_id, source)
);

-- ---------------------------------------------------------------------
-- 5. Couche automatisation — « l'IA propose, une règle explicite exécute »
-- ---------------------------------------------------------------------

-- Une ligne par type d'action automatisable. `mode` décide si l'IA agit
-- seule (auto), demande un clic (approve), ou reste éteinte (off).
-- Réglable dans l'interface, sans toucher au code.
create table if not exists automation_policies (
  kind        text primary key,
  label       text not null,
  description text,
  mode        text not null default 'approve' check (mode in ('auto','approve','off')),
  is_outbound boolean not null default false,   -- l'action sort de l'entreprise ?
  updated_by  uuid references members(id) on delete set null,
  updated_at  timestamptz not null default now()
);

create table if not exists ai_suggestions (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null references automation_policies(kind),
  title         text not null,
  rationale     text,
  payload       jsonb not null default '{}'::jsonb,
  confidence    numeric(3,2),
  source_type   text check (source_type in ('email','document','calendar','task','digest','manual')),
  source_id     uuid,
  task_id       uuid references tasks(id) on delete set null,
  status        text not null default 'pending'
                check (status in ('pending','approved','rejected','applied','failed','superseded')),
  decided_by    uuid references members(id) on delete set null,
  decided_at    timestamptz,
  applied_at    timestamptz,
  result        jsonb,
  error         text,
  created_at    timestamptz not null default now()
);
create index if not exists ai_suggestions_status_idx on ai_suggestions(status, created_at desc);

create table if not exists ai_run_log (
  id            uuid primary key default gen_random_uuid(),
  function_name text not null,
  model         text,
  ok            boolean not null default true,
  input_tokens  integer,
  output_tokens integer,
  duration_ms   integer,
  detail        text,
  created_at    timestamptz not null default now()
);
create index if not exists ai_run_log_created_idx on ai_run_log(created_at desc);

-- Journal unique : timeline d'une tâche, historique des décisions IA,
-- traçabilité de qui a changé quoi.
create table if not exists activity_log (
  id          uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id   uuid,
  actor_kind  text not null default 'human' check (actor_kind in ('human','ai','system')),
  member_id   uuid references members(id) on delete set null,
  action      text not null,
  summary     text,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists activity_log_entity_idx on activity_log(entity_type, entity_id, created_at desc);
create index if not exists activity_log_created_idx on activity_log(created_at desc);

create table if not exists notifications (
  id         uuid primary key default gen_random_uuid(),
  member_id  uuid references members(id) on delete cascade,
  level      text not null default 'info' check (level in ('info','warning','urgent')),
  title      text not null,
  body       text,
  link       text,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_member_idx on notifications(member_id, created_at desc);

create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references members(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- `create table if not exists` protège contre le doublon de TABLE, pas
-- contre l'absence d'une COLONNE ajoutée après coup : sur une base déjà
-- provisionnée, la définition ci-dessus est simplement ignorée en bloc.
-- Toute colonne ajoutée après la première rédaction de ce fichier a donc
-- besoin de sa propre garde.
alter table email_messages add column if not exists task_id uuid references tasks(id) on delete set null;
alter table documents      add column if not exists task_id uuid references tasks(id) on delete set null;

-- Posée ici et non dans la définition de `meetings` : calendar_events est
-- créée plus bas dans ce fichier.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'meetings_calendar_event_fk') then
    alter table meetings
      add constraint meetings_calendar_event_fk
      foreign key (calendar_event_id) references calendar_events(id) on delete set null;
  end if;
end $$;
