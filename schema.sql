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
  role text not null check (role in ('owner','tenant','admin')),
  created_at timestamptz default now()
);

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
  created_at timestamptz default now()
);

-- ============ WORKERS (répertoire) ============
create table workers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  specialty text,
  rbq_license text,
  phone text,
  created_at timestamptz default now()
);

-- ============ SERVICE REQUESTS (demandes des locataires) ============
create table service_requests (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid references units(id) on delete cascade,
  tenant_id uuid references tenants(id),
  description text not null,
  status text default 'open' check (status in ('open','in_progress','closed')),
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
  status text default 'open'
    check (status in ('open','assigned','in_progress','completed')),
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

-- ============ DOCUMENTS ============
create table documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references owners(id),
  building_id uuid references buildings(id),
  lease_id uuid references leases(id),
  title text not null,
  file_url text,
  doc_type text,   -- 'bail','mandat','reglement','rapport'
  created_at timestamptz default now()
);

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

create policy "own expenses" on expenses for select
  using (building_id in (select owned_building_ids()));

create policy "own approvals" on approvals for select
  using (owner_id = auth_owner_id());
create policy "own approvals update" on approvals for update
  using (owner_id = auth_owner_id());

create policy "own documents" on documents for select
  using (owner_id = auth_owner_id());

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

-- workers : pas de RLS restrictif nécessaire pour l'instant
-- (répertoire interne, accès géré via la clé service_role côté admin)
create policy "authenticated read workers" on workers for select
  using (auth.role() = 'authenticated');

-- inquiries : n'importe qui peut soumettre une demande via le
-- formulaire public ; seul un compte connecté (le gestionnaire)
-- peut les consulter et les mettre à jour.
create policy "public insert inquiries" on inquiries for insert
  with check (true);
create policy "authenticated read inquiries" on inquiries for select
  using (auth.role() = 'authenticated');
create policy "authenticated update inquiries" on inquiries for update
  using (auth.role() = 'authenticated');

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

-- ============================================================
-- NOTE IMPORTANTE
-- ============================================================
-- Ton outil interne (site-admin.html) doit utiliser la clé
-- "service_role" de Supabase, PAS la clé "anon" — la clé service_role
-- contourne le RLS et te donne accès à tous les clients. Elle ne
-- doit JAMAIS être exposée dans un fichier HTML public ; elle doit
-- rester côté serveur (ex: une fonction Supabase Edge Function, ou
-- un petit backend). C'est un point à valider avec Claude Code.
