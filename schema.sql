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

-- ============================================================
-- SÉCURITÉ — isolation stricte par propriétaire (RLS)
-- ============================================================
-- Fonction utilitaire : retourne l'owner_id du propriétaire
-- actuellement connecté (ou NULL si aucun).
create or replace function auth_owner_id()
returns uuid language sql stable as $$
  select id from owners where user_id = auth.uid()
$$;

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

create policy "self" on users for select using (id = auth.uid());

create policy "own profile" on owners for select using (user_id = auth.uid());

create policy "own buildings" on buildings for select
  using (owner_id = auth_owner_id());

create policy "own units" on units for select
  using (building_id in (select id from buildings where owner_id = auth_owner_id()));

create policy "own tenants" on tenants for select
  using (id in (
    select tenant_id from leases where unit_id in (
      select id from units where building_id in (
        select id from buildings where owner_id = auth_owner_id()))));

create policy "own leases" on leases for select
  using (unit_id in (select id from units where building_id in (
    select id from buildings where owner_id = auth_owner_id())));

create policy "own payments" on payments for select
  using (lease_id in (select id from leases where unit_id in (
    select id from units where building_id in (
      select id from buildings where owner_id = auth_owner_id()))));

create policy "own service_requests" on service_requests for select
  using (unit_id in (select id from units where building_id in (
    select id from buildings where owner_id = auth_owner_id())));

create policy "own work_orders" on work_orders for select
  using (unit_id in (select id from units where building_id in (
    select id from buildings where owner_id = auth_owner_id())));

create policy "own expenses" on expenses for select
  using (building_id in (select id from buildings where owner_id = auth_owner_id()));

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

-- workers : pas de RLS restrictif nécessaire pour l'instant
-- (répertoire interne, accès géré via la clé service_role côté admin)
create policy "authenticated read workers" on workers for select
  using (auth.role() = 'authenticated');

-- ============================================================
-- NOTE IMPORTANTE
-- ============================================================
-- Ton outil interne (site-admin.html) doit utiliser la clé
-- "service_role" de Supabase, PAS la clé "anon" — la clé service_role
-- contourne le RLS et te donne accès à tous les clients. Elle ne
-- doit JAMAIS être exposée dans un fichier HTML public ; elle doit
-- rester côté serveur (ex: une fonction Supabase Edge Function, ou
-- un petit backend). C'est un point à valider avec Claude Code.
