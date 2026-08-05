-- ============================================================
-- Portail — schéma de base de données (Supabase / Postgres)
-- À exécuter dans Project > SQL Editor > New query
-- ============================================================
-- Hiérarchie :
--   users (identité de connexion)
--     └─ owners
--          └─ buildings
--               └─ units
--                    ├─ tenants (via leases)
--                    └─ leases
--   + payments, service_requests, work_orders, expenses,
--     approvals, documents, messages, workers
-- ============================================================

create extension if not exists "pgcrypto";

-- ============ USERS ============
-- Profil public lié à l'identité Supabase Auth (auth.users).
-- Ne PAS recréer l'authentification ici — cette table stocke
-- seulement le rôle et sert de pont vers owners/tenants.
create table users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null check (role in ('owner','tenant','admin','worker')),
  is_admin boolean default false,
  created_at timestamptz default now()
);
-- is_admin est distinct de "role" : un même compte peut être à la
-- fois "owner" (rôle métier, gère ses propres immeubles) ET admin
-- (accès à portail-admin.html, vue multi-clients). Marquer un compte
-- admin : update users set is_admin = true where id = '<uuid>';

-- Crée automatiquement une ligne "users" quand un compte Auth est créé.
-- Le rôle par défaut est 'owner' — à ajuster à l'inscription si besoin.
create or replace function handle_new_auth_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.users (id, email, role)
  values (new.id, new.email, 'owner');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_auth_user();

-- ============ OWNERS ============
create table owners (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  full_name text not null,
  phone text,
  company_name text,
  spending_cap numeric(10,2) default 300,
  management_rate numeric(4,2) default 6.00,
  created_at timestamptz default now()
);

-- ============ BUILDINGS ============
create table buildings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references owners(id) on delete cascade,
  address text not null,
  unit_count int not null default 1,
  year_built int,
  created_at timestamptz default now()
);

-- ============ UNITS ============
create table units (
  id uuid primary key default gen_random_uuid(),
  building_id uuid references buildings(id) on delete cascade,
  unit_number text not null,
  unit_type text,                 -- ex: '3½', '4½'
  rent numeric(10,2),
  status text not null default 'occupied'
    check (status in ('occupied','available','soon_available')),
  status_changed_at timestamptz default now(),
  listing_description text,
  suggested_rent numeric(10,2),
  created_at timestamptz default now()
);

-- ============ TENANTS ============
create table tenants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),   -- nullable: un locataire n'a pas toujours de compte
  full_name text not null,
  email text,
  phone text,
  created_at timestamptz default now()
);

-- ============ LEASES ============
create table leases (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid references units(id) on delete cascade,
  tenant_id uuid references tenants(id),
  start_date date not null,
  end_date date,
  monthly_rent numeric(10,2) not null,
  status text default 'active' check (status in ('active','renewed','ended')),
  created_at timestamptz default now()
);

-- ============ PAYMENTS ============
create table payments (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid references leases(id) on delete cascade,
  amount numeric(10,2) not null,
  due_date date not null,
  paid_date date,
  status text default 'pending' check (status in ('paid','late','pending')),
  reminder_upcoming_sent boolean default false,
  reminder_late_sent boolean default false,
  created_at timestamptz default now()
);

-- ============ WORKERS (répertoire) ============
create table workers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),   -- nullable: accès portail travailleur optionnel
  name text not null,
  specialty text,
  rbq_license text,
  phone text,
  email text,
  created_at timestamptz default now()
);

-- ============ SERVICE REQUESTS (demandes des locataires) ============
create table service_requests (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid references units(id) on delete cascade,
  tenant_id uuid references tenants(id),
  description text not null,
  status text default 'open' check (status in ('open','in_progress','closed')),
  ai_category text,
  ai_estimated_cost numeric(10,2),
  ai_urgency text,
  created_at timestamptz default now()
);

-- ============ WORK ORDERS (travaux assignés) ============
create table work_orders (
  id uuid primary key default gen_random_uuid(),
  service_request_id uuid references service_requests(id),
  unit_id uuid references units(id) on delete cascade,
  worker_id uuid references workers(id),
  description text not null,
  estimated_cost numeric(10,2),
  worker_pay numeric(10,2),        -- montant payé au travailleur pour ce travail
  coordination_fee numeric(10,2),  -- frais Portail (10 % de worker_pay), facturés au propriétaire
  worker_notified boolean default false,
  status text default 'open'
    check (status in ('open','assigned','in_progress','completed','cancelled')),
  created_at timestamptz default now()
);

-- ============ EXPENSES (dépenses réalisées) ============
create table expenses (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid references work_orders(id),
  building_id uuid references buildings(id) on delete cascade,
  unit_id uuid references units(id),
  description text not null,
  amount numeric(10,2) not null,
  expense_date date not null,
  created_at timestamptz default now()
);

-- ============ APPROVALS (dépassement du plafond) ============
create table approvals (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid references work_orders(id) on delete cascade,
  owner_id uuid references owners(id),
  requested_amount numeric(10,2) not null,
  spending_cap_at_request numeric(10,2),
  status text default 'pending' check (status in ('pending','approved','rejected')),
  decided_at timestamptz,
  created_at timestamptz default now()
);

-- ============ PROSPECTS (pipeline CRM — acquisition propriétaires) ============
create table prospects (
  id uuid primary key default gen_random_uuid(),
  inquiry_id uuid references inquiries(id),
  full_name text not null,
  email text,
  phone text,
  company_name text,
  num_doors int,
  avg_rent numeric(10,2),
  potential_monthly_revenue numeric(10,2),   -- num_doors * avg_rent * 6%
  stage text default 'new'
    check (stage in ('new','contacted','interested','proposal_sent','signed','lost')),
  interest_level text check (interest_level in ('chaud','tiede','froid')),
  assigned_to text,
  next_followup_date date,
  call_history jsonb default '[]'::jsonb,
  notes text,
  created_at timestamptz default now()
);
-- Pas de policy RLS ouverte : accessible uniquement via le rôle
-- service_role (fonction Edge "crm-api", gardée par is_admin).

-- ============ FINANCIAL ANOMALIES (contrôle interne) ============
create table financial_anomalies (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('facture_dupliquee','depassement_cout','loyer_montant_incorrect','recu_manquant')),
  severity text not null default 'moyen' check (severity in ('critique','eleve','moyen')),
  description text not null,
  owner_id uuid references owners(id),
  related_expense_id uuid references expenses(id),
  related_payment_id uuid references payments(id),
  related_work_order_id uuid references work_orders(id),
  status text default 'open' check (status in ('open','resolved','dismissed')),
  created_at timestamptz default now()
);
-- Pas de policy RLS ouverte : accessible uniquement via le rôle
-- service_role (fonction Edge "admin-api", gardée par is_admin).

-- ============ AUDIT LOG (traçabilité des décisions) ============
create table audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null check (actor_type in ('admin','owner','tenant','system')),
  actor_id uuid,
  action text not null,
  entity_type text,
  entity_id uuid,
  details jsonb,
  created_at timestamptz default now()
);
-- Écriture uniquement via service_role (fonctions Edge et
-- déclencheurs security definer) ; lecture réservée à l'admin
-- (policy définie plus bas, après la fonction auth_is_admin()).

-- ============ PUBLIC SUBMISSION LOG (limite de débit anti-spam) ============
create table public_submission_log (
  id uuid primary key default gen_random_uuid(),
  ip_address text,
  created_at timestamptz default now()
);
-- Pas de policy RLS ouverte : écrit/lu uniquement par la fonction
-- Edge "handle-public-inquiry" (service_role).

-- ============ REPORTS (rapports mensuels propriétaires) ============
create table reports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references owners(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  rent_expected numeric(10,2),
  rent_received numeric(10,2),
  late_count int,
  occupancy_rate numeric(5,2),
  expenses_total numeric(10,2),
  work_orders_completed int,
  work_orders_in_progress int,
  management_fee numeric(10,2),
  net_due_to_owner numeric(10,2),
  renewals_upcoming int,
  summary text,
  created_at timestamptz default now()
);

-- ============ DOCUMENTS ============
create table documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references owners(id),
  building_id uuid references buildings(id),
  lease_id uuid references leases(id),
  title text not null,
  file_url text,
  doc_type text,   -- 'bail','mandat','reglement','rapport'
  ai_processed boolean default false,
  ai_summary text,
  ai_parties text,
  ai_key_amount numeric(10,2),
  ai_expiry_date date,
  ai_extracted jsonb,
  created_at timestamptz default now()
);

-- Ajoutée après "documents" pour respecter l'ordre des références
-- (une dépense peut pointer vers son reçu/sa facture téléversée).
alter table expenses add column receipt_document_id uuid references documents(id);

-- ============ MESSAGES ============
create table messages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references owners(id) on delete cascade,
  sender text not null check (sender in ('owner','team')),
  body text not null,
  created_at timestamptz default now()
);

-- ============ INQUIRIES (formulaires publics) ============
-- 'visite' = demande de visite pour un logement (unit_id renseigné)
-- 'mandat' = propriétaire prospect voulant confier son immeuble
create table inquiries (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('visite', 'mandat')),
  unit_id uuid references units(id),
  full_name text not null,
  email text not null,
  phone text,
  message text,
  -- Champs structurés propres aux demandes de mandat (type='mandat') :
  -- remplacent la zone de texte libre pour une meilleure qualification
  -- des prospects par le CRM.
  sector text,
  num_doors int,
  avg_rent numeric(10,2),
  ownership text check (ownership in ('personnel','societe')),
  current_management text check (current_management in ('autogere','sous_gestion')),
  services_needed text,
  main_problem text,
  desired_start_date date,
  best_call_time text,
  ai_category text,
  ai_summary text,
  ai_reply_sent boolean default false,
  status text default 'new' check (status in ('new', 'contacted', 'closed')),
  created_at timestamptz default now()
);

-- ============================================================
-- SÉCURITÉ — isolation stricte par propriétaire (RLS)
-- ============================================================
-- Fonctions utilitaires : identité de l'utilisateur connecté et
-- ensembles d'IDs qu'il possède/loue. SECURITY DEFINER + row_security
-- off est nécessaire ici : sans ça, ces fonctions déclenchent le RLS
-- des tables qu'elles interrogent, qui peut à son tour rappeler ces
-- mêmes fonctions ailleurs dans le graphe de policies — provoquant
-- une récursion infinie (erreur Postgres 42P17). Toute policy qui a
-- besoin de traverser plusieurs tables (immeuble → logement → bail...)
-- doit passer par une de ces fonctions plutôt que par une sous-requête
-- directe sur une autre table protégée par RLS.
create or replace function auth_owner_id()
returns uuid
language sql stable security definer set search_path = public set row_security = off
as $$ select id from owners where user_id = auth.uid() $$;

create or replace function auth_is_admin()
returns boolean
language sql stable security definer set search_path = public set row_security = off
as $$ select coalesce((select is_admin from users where id = auth.uid()), false) $$;

create or replace function auth_tenant_id()
returns uuid
language sql stable security definer set search_path = public set row_security = off
as $$ select id from tenants where user_id = auth.uid() $$;

create or replace function owned_building_ids()
returns setof uuid
language sql stable security definer set search_path = public set row_security = off
as $$ select id from buildings where owner_id = auth_owner_id() $$;

create or replace function owned_unit_ids()
returns setof uuid
language sql stable security definer set search_path = public set row_security = off
as $$ select id from units where building_id in (select owned_building_ids()) $$;

create or replace function owned_lease_ids()
returns setof uuid
language sql stable security definer set search_path = public set row_security = off
as $$ select id from leases where unit_id in (select owned_unit_ids()) $$;

create or replace function tenant_unit_ids()
returns setof uuid
language sql stable security definer set search_path = public set row_security = off
as $$ select unit_id from leases where tenant_id = auth_tenant_id() $$;

create or replace function tenant_building_ids()
returns setof uuid
language sql stable security definer set search_path = public set row_security = off
as $$ select building_id from units where id in (select tenant_unit_ids()) $$;

alter table users enable row level security;
alter table owners enable row level security;
alter table buildings enable row level security;
alter table units enable row level security;
alter table tenants enable row level security;
alter table leases enable row level security;
alter table payments enable row level security;
alter table service_requests enable row level security;
alter table work_orders enable row level security;
alter table expenses enable row level security;
alter table approvals enable row level security;
alter table documents enable row level security;
alter table messages enable row level security;
alter table workers enable row level security;
alter table inquiries enable row level security;
alter table reports enable row level security;
alter table prospects enable row level security;
alter table financial_anomalies enable row level security;
alter table public_submission_log enable row level security;
alter table audit_log enable row level security;

create policy "self" on users for select using (id = auth.uid());

create policy "own profile" on owners for select using (user_id = auth.uid());

create policy "own buildings" on buildings for select
  using (owner_id = auth_owner_id());

create policy "own units" on units for select
  using (building_id in (select owned_building_ids()));

create policy "own tenants" on tenants for select
  using (id in (select tenant_id from leases where unit_id in (select owned_unit_ids())));

create policy "own leases" on leases for select
  using (unit_id in (select owned_unit_ids()));

create policy "own payments" on payments for select
  using (lease_id in (select owned_lease_ids()));

create policy "own service_requests" on service_requests for select
  using (unit_id in (select owned_unit_ids()));

create policy "own work_orders" on work_orders for select
  using (unit_id in (select owned_unit_ids()));

-- L'admin gère déjà tout via les fonctions Edge (service_role,
-- contourne RLS), mais aucune policy ne lui permettait de lire ces
-- tables avec sa propre session — utile pour le support/diagnostic
-- direct, cohérent avec le même principe déjà appliqué à
-- inquiries/workers/audit_log.
create policy "admin read service_requests" on service_requests for select
  using (auth_is_admin());
create policy "admin read work_orders" on work_orders for select
  using (auth_is_admin());
create policy "admin read expenses" on expenses for select
  using (auth_is_admin());
create policy "admin read approvals" on approvals for select
  using (auth_is_admin());
create policy "admin read payments" on payments for select
  using (auth_is_admin());
create policy "admin read leases" on leases for select
  using (auth_is_admin());

create policy "own expenses" on expenses for select
  using (building_id in (select owned_building_ids()));

create policy "own approvals" on approvals for select
  using (owner_id = auth_owner_id());
create policy "own approvals update" on approvals for update
  using (owner_id = auth_owner_id());

create policy "own documents" on documents for select
  using (owner_id = auth_owner_id());
create policy "own documents insert" on documents for insert
  with check (owner_id = auth_owner_id());
create policy "own documents delete" on documents for delete
  using (owner_id = auth_owner_id() and doc_type <> 'facture');

create policy "own messages" on messages for select
  using (owner_id = auth_owner_id());
create policy "own messages insert" on messages for insert
  with check (owner_id = auth_owner_id());

-- Lecture publique limitée : le site client affiche les unités
-- disponibles sans authentification (annonces).
create policy "public read available units" on units for select
  using (status in ('available','soon_available'));

-- Permet au site client de lire l'adresse d'un immeuble uniquement
-- s'il a au moins une unité disponible (pour l'afficher sur l'annonce).
create policy "public read buildings with available units" on buildings for select
  using (id in (select building_id from units where status in ('available','soon_available')));

-- workers : répertoire interne. Un propriétaire doit pouvoir voir
-- les travailleurs (pour les afficher dans ses travaux/candidats),
-- un admin aussi. Un locataire ou un visiteur n'a aucune raison
-- d'y avoir accès (nom, téléphone, courriel, licence RBQ).
create policy "owner or admin read workers" on workers for select
  using (auth_is_admin() or auth_owner_id() is not null);

-- inquiries : la soumission publique NE passe PLUS par un insert
-- direct depuis le navigateur (aucune policy INSERT publique ici) —
-- elle passe obligatoirement par la fonction Edge
-- "handle-public-inquiry" (service_role), qui valide les champs,
-- vérifie le honeypot, limite le débit par IP et confirme que
-- l'unité existe/est disponible avant d'insérer. La lecture/mise à
-- jour complète est réservée à l'admin (les demandes de mandat sont
-- des prospects commerciaux confidentiels — un propriétaire ne doit
-- JAMAIS voir les demandes d'un autre client ni celles d'autres
-- prospects). Un propriétaire ne peut voir/gérer que les demandes
-- de visite pour SES unités.
create policy "admin read inquiries" on inquiries for select
  using (auth_is_admin());
create policy "admin update inquiries" on inquiries for update
  using (auth_is_admin());
create policy "owner read own unit visit inquiries" on inquiries for select
  using (type = 'visite' and unit_id in (select owned_unit_ids()));
create policy "owner update own unit visit inquiries" on inquiries for update
  using (type = 'visite' and unit_id in (select owned_unit_ids()));

-- Accès en libre-service pour un locataire connecté à son propre
-- bail, unité, immeuble, paiements et demandes de service.
create policy "own tenant profile" on tenants for select
  using (user_id = auth.uid());
create policy "own leases as tenant" on leases for select
  using (tenant_id = auth_tenant_id());
create policy "own payments as tenant" on payments for select
  using (lease_id in (select id from leases where tenant_id = auth_tenant_id()));
create policy "own unit as tenant" on units for select
  using (id in (select tenant_unit_ids()));
create policy "own building as tenant" on buildings for select
  using (id in (select tenant_building_ids()));
create policy "own service_requests as tenant select" on service_requests for select
  using (tenant_id = auth_tenant_id());
create policy "own service_requests as tenant insert" on service_requests for insert
  with check (tenant_id = auth_tenant_id());

create policy "own reports" on reports for select
  using (owner_id = auth_owner_id());

create policy "admin read audit_log" on audit_log for select
  using (auth_is_admin());

-- IMPORTANT : la création/assignation d'un work_order, sa complétion,
-- l'enregistrement de la dépense finale et l'avancement du statut
-- d'une demande de service ne passent PLUS par un accès direct du
-- propriétaire à ces tables (aucune policy INSERT/UPDATE pour lui
-- ici) — ce sont des actions opérationnelles/financières réservées
-- à l'équipe, exécutées uniquement via la fonction Edge "ops-api"
-- (service_role, gardée par is_admin). Le propriétaire garde un
-- accès lecture seule (policies "own work_orders", "own expenses",
-- "own service_requests" plus haut) et peut approuver/refuser une
-- dépense (policy "own approvals update").

-- ============================================================
-- AUTOMATISATION IA — traitement des demandes du formulaire
-- ============================================================
-- Déclenche la fonction Edge "handle-inquiry" à chaque nouvelle
-- demande : elle catégorise/résume via l'IA, répond au visiteur
-- par courriel (Resend), et met à jour ai_category/ai_summary.
-- Nécessite les secrets ANTHROPIC_API_KEY et RESEND_API_KEY
-- configurés dans Project Settings > Edge Functions > Secrets,
-- et la vérification JWT désactivée sur cette fonction.
create extension if not exists pg_net with schema extensions;

create or replace function notify_new_inquiry()
returns trigger language plpgsql as $$
begin
  perform net.http_post(
    url := 'https://kdmwfbcziokygfcmjxeq.supabase.co/functions/v1/handle-inquiry',
    body := jsonb_build_object('type', 'INSERT', 'table', 'inquiries', 'record', to_jsonb(NEW)),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR',
      'apikey', 'sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR'
    )
  );
  return NEW;
end;
$$;

create trigger on_inquiry_insert
  after insert on inquiries
  for each row execute function notify_new_inquiry();

-- Approuve automatiquement (crée une ligne "approvals" en attente)
-- tout work_order dont le coût estimé dépasse le plafond du
-- propriétaire concerné.
create or replace function check_work_order_approval()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_owner_id uuid;
  v_cap numeric;
begin
  select o.id, o.spending_cap into v_owner_id, v_cap
  from owners o
  join buildings b on b.owner_id = o.id
  join units u on u.building_id = b.id
  where u.id = NEW.unit_id;

  if NEW.estimated_cost is not null and NEW.estimated_cost > v_cap then
    insert into approvals (work_order_id, owner_id, requested_amount, spending_cap_at_request, status)
    values (NEW.id, v_owner_id, NEW.estimated_cost, v_cap, 'pending');
  end if;
  return NEW;
end;
$$;

create trigger on_work_order_insert
  after insert on work_orders
  for each row execute function check_work_order_approval();

-- Drapeaux de sécurité déterministes : posés par l'edge function
-- handle-service-request, JAMAIS par l'IA elle-même. Si un mot-clé de
-- danger (gaz, feu, fuite active, etc.) est détecté dans la description,
-- safety_override force ai_urgency à 'urgence' peu importe la réponse
-- de Claude, et les admins sont alertés par courriel immédiatement.
alter table service_requests add column if not exists safety_override boolean default false;
alter table service_requests add column if not exists safety_flags text[] default '{}';

-- Déclenche la fonction Edge "handle-service-request" à chaque
-- nouvelle demande de service : l'IA catégorise le problème, propose
-- une estimation de coût préliminaire et un niveau d'urgence, affichés
-- directement dans l'onglet "Travaux" du propriétaire.
create or replace function notify_new_service_request()
returns trigger language plpgsql as $$
begin
  perform net.http_post(
    url := 'https://kdmwfbcziokygfcmjxeq.supabase.co/functions/v1/handle-service-request',
    body := jsonb_build_object('type', 'INSERT', 'table', 'service_requests', 'record', to_jsonb(NEW)),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR',
      'apikey', 'sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR'
    )
  );
  return NEW;
end;
$$;

create trigger on_service_request_insert
  after insert on service_requests
  for each row execute function notify_new_service_request();

-- ============================================================
-- RAPPELS DE PAIEMENT AUTOMATIQUES
-- ============================================================
-- Tâche cron quotidienne (pg_cron) : marque les paiements en retard
-- (status 'pending' dont l'échéance est passée -> 'late'), puis
-- déclenche la fonction Edge "handle-payment-reminder" pour chaque
-- paiement qui approche de son échéance (rappel préventif, 3 jours
-- avant) ou qui vient de passer en retard. Chaque rappel n'est
-- envoyé qu'une seule fois par paiement (colonnes reminder_*_sent).
create extension if not exists pg_cron with schema extensions;

create or replace function trigger_payment_reminders()
returns void language plpgsql security definer set search_path = public as $$
declare
  p record;
begin
  update payments set status = 'late'
  where status = 'pending' and due_date < current_date;

  for p in
    select id from payments
    where status = 'pending'
    and due_date between current_date and current_date + interval '3 days'
    and reminder_upcoming_sent = false
  loop
    perform net.http_post(
      url := 'https://kdmwfbcziokygfcmjxeq.supabase.co/functions/v1/handle-payment-reminder',
      body := jsonb_build_object('payment_id', p.id, 'reminder_type', 'upcoming'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR',
        'apikey', 'sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR'
      )
    );
    update payments set reminder_upcoming_sent = true where id = p.id;
  end loop;

  for p in
    select id from payments
    where status = 'late' and reminder_late_sent = false
  loop
    perform net.http_post(
      url := 'https://kdmwfbcziokygfcmjxeq.supabase.co/functions/v1/handle-payment-reminder',
      body := jsonb_build_object('payment_id', p.id, 'reminder_type', 'late'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR',
        'apikey', 'sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR'
      )
    );
    update payments set reminder_late_sent = true where id = p.id;
  end loop;
end;
$$;

select cron.schedule('daily-payment-reminders', '0 13 * * *', $$select trigger_payment_reminders()$$);

-- ============================================================
-- NOTIFICATION DES TRAVAILLEURS — nouvelle job assignée
-- ============================================================
-- Dès qu'un work_order se voit attribuer (ou changer) un worker_id,
-- déclenche la fonction Edge "handle-worker-job-assigned" qui
-- envoie au travailleur un courriel avec les détails du travail et
-- la paie prévue (worker_pay). Un seul envoi par affectation
-- (worker_notified).
--
-- IMPORTANT : si le coût estimé dépasse le plafond du propriétaire
-- (donc qu'une approbation est requise, voir check_work_order_approval
-- ci-dessus), on NE notifie PAS le travailleur tout de suite — il
-- sera avisé seulement après la décision du propriétaire (voir
-- handle_approval_decision plus bas).
create or replace function notify_worker_new_job()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_cap numeric;
  v_needs_approval boolean := false;
begin
  if new.worker_id is not null
     and (TG_OP = 'INSERT' or old.worker_id is distinct from new.worker_id)
     and coalesce(new.worker_notified, false) = false then

    select o.spending_cap into v_cap
    from owners o
    join buildings b on b.owner_id = o.id
    join units u on u.building_id = b.id
    where u.id = new.unit_id;

    if new.estimated_cost is not null and v_cap is not null and new.estimated_cost > v_cap then
      v_needs_approval := true;
    end if;

    if not v_needs_approval then
      perform net.http_post(
        url := 'https://kdmwfbcziokygfcmjxeq.supabase.co/functions/v1/handle-worker-job-assigned',
        body := jsonb_build_object('work_order_id', new.id),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR',
          'apikey', 'sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR'
        )
      );
      new.worker_notified := true;
    end if;
  end if;
  return new;
end;
$$;

create trigger on_work_order_worker_assigned
  before insert or update on work_orders
  for each row execute function notify_worker_new_job();

-- ============================================================
-- DÉCISION D'APPROBATION — ferme automatiquement la boucle
-- ============================================================
-- Quand le propriétaire approuve ou refuse une dépense (table
-- approvals), déclenche automatiquement la suite :
--   approuvée -> avise le travailleur (mandat) + avise le locataire
--   refusée   -> annule le work_order + avise le locataire
create or replace function handle_approval_decision()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'pending' and new.status = 'approved' then
    perform net.http_post(
      url := 'https://kdmwfbcziokygfcmjxeq.supabase.co/functions/v1/handle-worker-job-assigned',
      body := jsonb_build_object('work_order_id', new.work_order_id),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR',
        'apikey', 'sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR'
      )
    );
    update work_orders set worker_notified = true where id = new.work_order_id;

    perform net.http_post(
      url := 'https://kdmwfbcziokygfcmjxeq.supabase.co/functions/v1/handle-approval-decision',
      body := jsonb_build_object('approval_id', new.id, 'decision', 'approved'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR',
        'apikey', 'sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR'
      )
    );
    insert into audit_log (actor_type, actor_id, action, entity_type, entity_id, details)
    values ('owner', auth.uid(), 'approval.approved', 'approvals', new.id,
      jsonb_build_object('work_order_id', new.work_order_id, 'requested_amount', new.requested_amount));
  elsif old.status = 'pending' and new.status = 'rejected' then
    update work_orders set status = 'cancelled' where id = new.work_order_id;

    perform net.http_post(
      url := 'https://kdmwfbcziokygfcmjxeq.supabase.co/functions/v1/handle-approval-decision',
      body := jsonb_build_object('approval_id', new.id, 'decision', 'rejected'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR',
        'apikey', 'sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR'
      )
    );
    insert into audit_log (actor_type, actor_id, action, entity_type, entity_id, details)
    values ('owner', auth.uid(), 'approval.rejected', 'approvals', new.id,
      jsonb_build_object('work_order_id', new.work_order_id, 'requested_amount', new.requested_amount));
  end if;
  return new;
end;
$$;

create trigger on_approval_decided
  after update on approvals
  for each row execute function handle_approval_decision();

-- ============================================================
-- RAPPORTS PROPRIÉTAIRES MENSUELS
-- ============================================================
-- Le 1er de chaque mois à 7h (heure de l'Est), génère le rapport du
-- mois précédent pour chaque propriétaire en déclenchant la fonction
-- Edge "generate-owner-report", qui calcule les chiffres et rédige
-- un résumé via l'IA, puis insère la ligne dans la table "reports".
create or replace function trigger_monthly_owner_reports()
returns void language plpgsql security definer set search_path = public as $$
declare
  o record;
  v_period_start date := date_trunc('month', current_date - interval '1 month')::date;
  v_period_end date := (date_trunc('month', current_date) - interval '1 day')::date;
begin
  for o in select id from owners loop
    perform net.http_post(
      url := 'https://kdmwfbcziokygfcmjxeq.supabase.co/functions/v1/generate-owner-report',
      body := jsonb_build_object(
        'owner_id', o.id,
        'period_start', v_period_start,
        'period_end', v_period_end
      ),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR',
        'apikey', 'sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR'
      )
    );
  end loop;
end;
$$;

select cron.schedule('monthly-owner-reports', '0 11 1 * *', $$select trigger_monthly_owner_reports()$$);

-- ============================================================
-- EXTRACTION IA DES DOCUMENTS
-- ============================================================
-- À chaque document téléversé avec un fichier, déclenche la
-- fonction Edge "handle-document-upload" qui lit le PDF/image et
-- en extrait un résumé, les parties, un montant clé et une date
-- d'échéance (baux, mandats, factures, assurances, licences...).
create or replace function notify_new_document()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.file_url is not null then
    perform net.http_post(
      url := 'https://kdmwfbcziokygfcmjxeq.supabase.co/functions/v1/handle-document-upload',
      body := jsonb_build_object('document_id', new.id),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR',
        'apikey', 'sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR'
      )
    );
  end if;
  return new;
end;
$$;

create trigger on_document_insert
  after insert on documents
  for each row execute function notify_new_document();

-- ============================================================
-- LOCATION DES LOGEMENTS — annonce générée automatiquement
-- ============================================================
-- Dès qu'une unité devient "available"/"soon_available" (ou que son
-- loyer est ajusté pendant qu'elle l'est déjà), déclenche la
-- fonction Edge "generate-listing" qui rédige une annonce et
-- suggère un loyer basé sur les unités comparables du portefeuille.
-- status_changed_at sert à calculer depuis combien de temps le
-- logement est vacant (détection d'anomalie côté portail).
create or replace function notify_listing_needed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('available','soon_available')
     and (
       TG_OP = 'INSERT'
       or old.status is distinct from new.status
       or old.rent is distinct from new.rent
     )
  then
    if TG_OP = 'UPDATE' and old.status is distinct from new.status then
      new.status_changed_at := now();
    end if;
    perform net.http_post(
      url := 'https://kdmwfbcziokygfcmjxeq.supabase.co/functions/v1/generate-listing',
      body := jsonb_build_object('unit_id', new.id),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR',
        'apikey', 'sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR'
      )
    );
  end if;
  return new;
end;
$$;

create trigger on_unit_listing_change
  before insert or update on units
  for each row execute function notify_listing_needed();

-- ============================================================
-- CRM COMMERCIAL — création automatique d'un prospect
-- ============================================================
-- Chaque demande de mandat (inquiries.type = 'mandat', soumise
-- depuis le site public) déclenche la fonction Edge
-- "handle-mandat-inquiry" : elle tente d'extraire le nombre de
-- portes et le loyer moyen mentionnés dans le message, calcule la
-- valeur potentielle (portes × loyer moyen × 6 %) et crée la ligne
-- correspondante dans le pipeline "prospects".
create or replace function notify_new_mandat_inquiry()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.type = 'mandat' then
    perform net.http_post(
      url := 'https://kdmwfbcziokygfcmjxeq.supabase.co/functions/v1/handle-mandat-inquiry',
      body := jsonb_build_object('inquiry_id', new.id),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR',
        'apikey', 'sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR'
      )
    );
  end if;
  return new;
end;
$$;

create trigger on_mandat_inquiry_insert
  after insert on inquiries
  for each row execute function notify_new_mandat_inquiry();

-- ============================================================
-- COMPTABILITÉ OPÉRATIONNELLE — détection d'anomalies
-- ============================================================
-- Purement déterministe (aucun appel IA nécessaire) : comparaisons
-- de données directes. Tourne une fois par jour, ajoute une ligne
-- dans "financial_anomalies" pour chaque cas détecté qui n'a pas
-- déjà été signalé (et pas rejeté manuellement).
create or replace function detect_financial_anomalies()
returns void language plpgsql security definer set search_path = public as $$
begin
  -- 1. Factures en double : même immeuble, même montant, à 3 jours d'écart ou moins
  insert into financial_anomalies (type, severity, description, owner_id, related_expense_id)
  select 'facture_dupliquee', 'eleve',
    'Deux dépenses similaires (' || e1.amount || ' $) pour le même immeuble à ' || abs(e1.expense_date - e2.expense_date) || ' jour(s) d''écart.',
    b.owner_id, e1.id
  from expenses e1
  join expenses e2 on e2.building_id = e1.building_id
    and e2.amount = e1.amount
    and e2.id <> e1.id
    and abs(e1.expense_date - e2.expense_date) <= 3
  join buildings b on b.id = e1.building_id
  where e1.id < e2.id
    and not exists (
      select 1 from financial_anomalies fa
      where fa.type = 'facture_dupliquee' and fa.related_expense_id = e1.id and fa.status <> 'dismissed'
    );

  -- 2. Dépassement de coût : dépense finale > 120% du coût estimé du travail
  insert into financial_anomalies (type, severity, description, owner_id, related_expense_id, related_work_order_id)
  select 'depassement_cout', 'moyen',
    'Coût final (' || e.amount || ' $) supérieur de plus de 20% à l''estimation (' || wo.estimated_cost || ' $).',
    b.owner_id, e.id, wo.id
  from expenses e
  join work_orders wo on wo.id = e.work_order_id
  join buildings b on b.id = e.building_id
  where wo.estimated_cost is not null
    and e.amount > wo.estimated_cost * 1.2
    and not exists (
      select 1 from financial_anomalies fa
      where fa.type = 'depassement_cout' and fa.related_expense_id = e.id and fa.status <> 'dismissed'
    );

  -- 3. Loyer reçu avec un montant différent de celui du bail
  insert into financial_anomalies (type, severity, description, owner_id, related_payment_id)
  select 'loyer_montant_incorrect', 'moyen',
    'Paiement de ' || p.amount || ' $ reçu alors que le loyer du bail est de ' || l.monthly_rent || ' $.',
    b.owner_id, p.id
  from payments p
  join leases l on l.id = p.lease_id
  join units u on u.id = l.unit_id
  join buildings b on b.id = u.building_id
  where p.status = 'paid'
    and p.amount <> l.monthly_rent
    and not exists (
      select 1 from financial_anomalies fa
      where fa.type = 'loyer_montant_incorrect' and fa.related_payment_id = p.id and fa.status <> 'dismissed'
    );

  -- 4. Dépense sans facture/reçu joint (au-delà d'un petit montant, pour limiter le bruit)
  insert into financial_anomalies (type, severity, description, owner_id, related_expense_id)
  select 'recu_manquant', 'moyen',
    'Dépense de ' || e.amount || ' $ enregistrée sans facture/reçu joint.',
    b.owner_id, e.id
  from expenses e
  join buildings b on b.id = e.building_id
  where e.receipt_document_id is null
    and e.amount > 50
    and not exists (
      select 1 from financial_anomalies fa
      where fa.type = 'recu_manquant' and fa.related_expense_id = e.id and fa.status <> 'dismissed'
    );
end;
$$;

select cron.schedule('daily-financial-anomalies', '0 12 * * *', $$select detect_financial_anomalies()$$);

-- ============================================================
-- STOCKAGE — upload de documents (baux, mandats, rapports)
-- ============================================================
-- Bucket privé : chaque propriétaire ne peut lire/écrire que dans
-- son propre dossier (nommé d'après son owner_id).
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

create policy "owner upload own documents" on storage.objects for insert
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = auth_owner_id()::text);
create policy "owner read own documents" on storage.objects for select
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = auth_owner_id()::text);
create policy "owner delete own documents" on storage.objects for delete
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = auth_owner_id()::text);

-- ============================================================
-- NOTE IMPORTANTE
-- ============================================================
-- Ton outil interne (site-admin.html) doit utiliser la clé
-- "service_role" de Supabase, PAS la clé "anon" — la clé service_role
-- contourne le RLS et te donne accès à tous les clients. Elle ne
-- doit JAMAIS être exposée dans un fichier HTML public ; elle doit
-- rester côté serveur (ex: une fonction Supabase Edge Function, ou
-- un petit backend). C'est un point à valider avec Claude Code.
