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

-- ============ BANK TRANSACTIONS (rapprochement par import CSV) ============
-- Pas de connexion bancaire en temps réel (nécessiterait Plaid/Flinks) :
-- l'admin importe un relevé exporté par sa banque. Le rapprochement
-- (montant, locataire, bail, mois) est entièrement déterministe ;
-- l'IA sert uniquement à suggérer une piste quand aucune correspondance
-- automatique n'est trouvée (ex: description bancaire cryptique).
create table bank_transactions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references owners(id) on delete cascade,
  transaction_date date not null,
  description text not null,
  amount numeric(10,2) not null,
  match_status text default 'unmatched' check (match_status in ('matched','partial','overpaid','duplicate','unmatched','ignored')),
  matched_payment_id uuid references payments(id),
  ai_suggested_tenant_id uuid references tenants(id),
  ai_suggestion_note text,
  ai_confidence numeric(5,2),
  reconciled_by uuid references users(id),
  reconciled_at timestamptz,
  created_at timestamptz default now()
);
-- Pas de policy RLS ouverte : accessible uniquement via le rôle
-- service_role (fonction Edge "reconcile-bank-transactions", gardée par is_admin).

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

-- Enrichissement CRM : complétude, probabilité de signature et
-- prochain geste sont calculés déterministiquement (table de
-- correspondance sur l'étape + l'intérêt, jamais estimés par l'IA).
-- lead_source/acquisition_cost/loss_reason sont saisis explicitement
-- par la source du prospect ou par l'admin.
alter table prospects add column if not exists completeness_score int;
alter table prospects add column if not exists lead_source text;
alter table prospects add column if not exists acquisition_cost numeric(10,2);
alter table prospects add column if not exists signing_probability int;
alter table prospects add column if not exists next_action text;
alter table prospects add column if not exists vendor_commission_estimate numeric(10,2);
alter table prospects add column if not exists loss_reason text;

create or replace function compute_prospect_derived_fields()
returns trigger language plpgsql as $$
declare
  v_filled int := 0;
  v_total int := 6;
begin
  if new.full_name is not null and new.full_name <> '' then v_filled := v_filled + 1; end if;
  if new.email is not null and new.email <> '' then v_filled := v_filled + 1; end if;
  if new.phone is not null and new.phone <> '' then v_filled := v_filled + 1; end if;
  if new.company_name is not null and new.company_name <> '' then v_filled := v_filled + 1; end if;
  if new.num_doors is not null then v_filled := v_filled + 1; end if;
  if new.avg_rent is not null then v_filled := v_filled + 1; end if;
  new.completeness_score := round((v_filled::numeric / v_total) * 100);

  new.signing_probability := case new.stage
    when 'signed' then 100
    when 'lost' then 0
    when 'proposal_sent' then case new.interest_level when 'chaud' then 70 when 'tiede' then 45 when 'froid' then 20 else 50 end
    when 'interested' then case new.interest_level when 'chaud' then 55 when 'tiede' then 30 when 'froid' then 10 else 35 end
    when 'contacted' then case new.interest_level when 'chaud' then 35 when 'tiede' then 20 when 'froid' then 5 else 20 end
    else 10
  end;

  new.next_action := case new.stage
    when 'new' then 'Premier contact à effectuer'
    when 'contacted' then 'Qualifier l''intérêt (appel de suivi)'
    when 'interested' then 'Envoyer une proposition/soumission'
    when 'proposal_sent' then 'Relancer pour obtenir la décision'
    when 'signed' then 'Amorcer l''onboarding du nouveau client'
    when 'lost' then 'Aucune action — dossier fermé'
    else null
  end;

  -- Estimation de référence seulement (10 % des frais de gestion du
  -- 1er mois) — à ajuster selon la vraie structure de commission.
  if new.potential_monthly_revenue is not null then
    new.vendor_commission_estimate := round(new.potential_monthly_revenue * 0.10 * 100) / 100;
  end if;

  return new;
end;
$$;

create trigger on_prospect_change
  before insert or update on prospects
  for each row execute function compute_prospect_derived_fields();

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

-- Rapport enrichi : factures sans reçu, travaux ayant dépassé leur
-- estimation, actions concrètes attendues du propriétaire, comparaison
-- avec le mois précédent, et statut du rapprochement bancaire (absent
-- tant qu'aucun compte bancaire n'est lié — voir automatisation
-- "rapprochement des paiements" séparée, aucune donnée inventée ici).
alter table reports add column if not exists missing_receipts_count int default 0;
alter table reports add column if not exists missing_receipts jsonb;
alter table reports add column if not exists over_estimate_count int default 0;
alter table reports add column if not exists over_estimate_work_orders jsonb;
alter table reports add column if not exists owner_actions_needed jsonb;
alter table reports add column if not exists bank_reconciliation_status text default 'non_connecte';
alter table reports add column if not exists prev_rent_received numeric(10,2);
alter table reports add column if not exists prev_occupancy_rate numeric(5,2);
alter table reports add column if not exists prev_expenses_total numeric(10,2);
alter table reports add column if not exists prev_net_due_to_owner numeric(10,2);

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

-- Traçabilité de l'extraction IA : chaque champ extrait doit pouvoir
-- être vérifié (confiance, page/passage source, version du modèle,
-- date d'extraction) plutôt que présenté comme une certitude. Détection
-- de doublons par hash de fichier. ai_needs_human_validation signale
-- qu'un humain doit valider avant de se fier à l'extraction (confiance
-- sous 85%, document illisible, type détecté ≠ type déclaré, doublon,
-- ou info manquante signalée par l'IA elle-même).
alter table documents add column if not exists ai_confidence numeric(5,2);
alter table documents add column if not exists ai_source_page int;
alter table documents add column if not exists ai_source_excerpt text;
alter table documents add column if not exists ai_model_version text;
alter table documents add column if not exists ai_extracted_at timestamptz;
alter table documents add column if not exists ai_readable boolean;
alter table documents add column if not exists ai_signature_present boolean;
alter table documents add column if not exists ai_doc_type_detected text;
alter table documents add column if not exists ai_needs_human_validation boolean default false;
alter table documents add column if not exists file_hash text;
alter table documents add column if not exists is_duplicate_of uuid references documents(id);

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

-- Catégorisation enrichie : au-delà de catégorie/coût/urgence, l'IA
-- explique son incertitude plutôt que de la cacher. ai_needs_review
-- signale à l'admin qu'un humain doit valider avant d'agir.
alter table service_requests add column if not exists ai_subcategory text;
alter table service_requests add column if not exists ai_cost_min numeric(10,2);
alter table service_requests add column if not exists ai_cost_max numeric(10,2);
alter table service_requests add column if not exists ai_confidence numeric(5,2);
alter table service_requests add column if not exists ai_missing_info text;
alter table service_requests add column if not exists ai_photos_needed boolean;
alter table service_requests add column if not exists ai_recommended_trade text;
alter table service_requests add column if not exists ai_immediate_action text;
alter table service_requests add column if not exists ai_risk_if_no_action text;
alter table service_requests add column if not exists ai_needs_review boolean default false;

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

-- Garde-fous des rappels de loyer (voir aussi payment_reminders plus
-- bas pour l'historique complet) :
--   - reminder_paused    : un admin/propriétaire a conclu une entente
--                          avec le locataire — plus aucun rappel tant
--                          que ce n'est pas remis à false.
--   - late_reminder_count / last_late_reminder_at : fréquence maximale
--                          d'un rappel de retard tous les 5 jours,
--                          plafonnée à 3 rappels au locataire.
--   - escalated_to_human : après 3 rappels sans paiement, on arrête
--                          d'écrire au locataire et on avise un admin —
--                          l'IA ne poursuit jamais seule au-delà de ce point.
alter table payments add column if not exists reminder_paused boolean default false;
alter table payments add column if not exists late_reminder_count int default 0;
alter table payments add column if not exists last_late_reminder_at timestamptz;
alter table payments add column if not exists escalated_to_human boolean default false;

-- ============ PAYMENT REMINDERS (historique complet des rappels envoyés) ============
create table payment_reminders (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid references payments(id) on delete cascade,
  reminder_type text not null check (reminder_type in ('upcoming','late','escalate')),
  sequence_number int,
  recipient text,
  subject text,
  body text,
  sent_at timestamptz default now()
);
alter table payment_reminders enable row level security;
create policy "admin read payment_reminders" on payment_reminders for select
  using (auth_is_admin());

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
    and coalesce(reminder_paused, false) = false
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

  -- Rappels de retard : au plus 1 tous les 5 jours, plafonné à 3.
  for p in
    select id from payments
    where status = 'late'
    and coalesce(reminder_paused, false) = false
    and coalesce(escalated_to_human, false) = false
    and coalesce(late_reminder_count, 0) < 3
    and (last_late_reminder_at is null or last_late_reminder_at <= now() - interval '5 days')
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
    update payments set late_reminder_count = coalesce(late_reminder_count, 0) + 1, last_late_reminder_at = now() where id = p.id;
  end loop;

  -- Escalade humaine : 3 rappels envoyés, toujours en retard 5 jours plus
  -- tard -> on cesse d'écrire au locataire et on avise un admin.
  for p in
    select id from payments
    where status = 'late'
    and coalesce(reminder_paused, false) = false
    and coalesce(escalated_to_human, false) = false
    and coalesce(late_reminder_count, 0) >= 3
    and last_late_reminder_at <= now() - interval '5 days'
  loop
    perform net.http_post(
      url := 'https://kdmwfbcziokygfcmjxeq.supabase.co/functions/v1/handle-payment-reminder',
      body := jsonb_build_object('payment_id', p.id, 'reminder_type', 'escalate'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR',
        'apikey', 'sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR'
      )
    );
    update payments set escalated_to_human = true where id = p.id;
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
-- Assignation transactionnelle : le travailleur doit répondre
-- (accepter / refuser / proposer une autre heure / demander des infos)
-- via un lien à usage unique (worker_response_token). Voir plus bas
-- process_worker_response_timeouts() pour le rappel (30 min), la
-- cascade au prochain travailleur (2h) et l'alerte admin si tous
-- refusent.
alter table work_orders add column if not exists worker_notified_at timestamptz;
alter table work_orders add column if not exists worker_response text default 'pending' check (worker_response in ('pending','accepted','declined','proposed_other_time','info_requested'));
alter table work_orders add column if not exists worker_response_at timestamptz;
alter table work_orders add column if not exists worker_response_token uuid default gen_random_uuid();
alter table work_orders add column if not exists worker_response_note text;
alter table work_orders add column if not exists declined_worker_ids uuid[] default '{}';
alter table work_orders add column if not exists response_reminder_sent boolean default false;
alter table work_orders add column if not exists response_escalated boolean default false;
alter table work_orders add column if not exists appointment_at timestamptz;
alter table work_orders add column if not exists entry_permission text;
alter table work_orders add column if not exists billing_terms text;
alter table work_orders add column if not exists due_by date;

-- Étape manquante du cycle de réparation : confirmation du locataire
-- avant fermeture définitive du dossier. Le service_request reste
-- "in_progress" après complétion tant que le locataire n'a pas
-- confirmé (ou que le délai de relance n'est pas expiré).
alter table work_orders add column if not exists tenant_confirmed boolean;
alter table work_orders add column if not exists tenant_confirmation_sent_at timestamptz;
alter table work_orders add column if not exists tenant_confirmation_token uuid default gen_random_uuid();
alter table work_orders add column if not exists tenant_confirmation_note text;
alter table work_orders add column if not exists tenant_reminder_sent boolean default false;

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
      -- Nouvelle notification = nouveau cycle de réponse (token,
      -- compteurs et statut remis à zéro), que ce soit la 1ère
      -- affectation ou une cascade vers le prochain travailleur.
      new.worker_notified := true;
      new.worker_notified_at := now();
      new.worker_response := 'pending';
      new.worker_response_token := gen_random_uuid();
      new.worker_response_note := null;
      new.response_reminder_sent := false;
      new.response_escalated := false;

      perform net.http_post(
        url := 'https://kdmwfbcziokygfcmjxeq.supabase.co/functions/v1/handle-worker-job-assigned',
        body := jsonb_build_object('work_order_id', new.id, 'response_token', new.worker_response_token, 'notification_type', 'assigned'),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR',
          'apikey', 'sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR'
        )
      );
    end if;
  end if;
  return new;
end;
$$;

create trigger on_work_order_worker_assigned
  before insert or update on work_orders
  for each row execute function notify_worker_new_job();

-- Rappel (30 min sans réponse), cascade au prochain travailleur
-- disponible de la même spécialité (2h sans réponse), et alerte admin
-- si plus aucun travailleur disponible n'a accepté.
create or replace function process_worker_response_timeouts()
returns void language plpgsql security definer set search_path = public as $$
declare
  wo record;
  v_next_worker_id uuid;
  v_admin_count int;
begin
  -- 1. Rappel après 30 minutes sans réponse.
  for wo in
    select id from work_orders
    where worker_response = 'pending'
    and worker_notified = true
    and coalesce(response_reminder_sent, false) = false
    and worker_notified_at <= now() - interval '30 minutes'
  loop
    perform net.http_post(
      url := 'https://kdmwfbcziokygfcmjxeq.supabase.co/functions/v1/handle-worker-job-assigned',
      body := jsonb_build_object('work_order_id', wo.id, 'notification_type', 'reminder'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR',
        'apikey', 'sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR'
      )
    );
    update work_orders set response_reminder_sent = true where id = wo.id;
  end loop;

  -- 2. Après 2 heures sans réponse : cascade au prochain travailleur
  --    disponible de la même spécialité (jamais déjà sollicité pour ce travail).
  for wo in
    select w.id, w.worker_id, w.declined_worker_ids, wk.specialty
    from work_orders w
    join workers wk on wk.id = w.worker_id
    where w.worker_response = 'pending'
    and w.worker_notified = true
    and coalesce(w.response_escalated, false) = false
    and w.worker_notified_at <= now() - interval '2 hours'
  loop
    select id into v_next_worker_id
    from workers
    where specialty is not distinct from wo.specialty
    and id <> wo.worker_id
    and not (id = any(coalesce(wo.declined_worker_ids, '{}')))
    order by random()
    limit 1;

    if v_next_worker_id is not null then
      update work_orders set
        declined_worker_ids = array_append(coalesce(declined_worker_ids, '{}'), worker_id),
        worker_id = v_next_worker_id,
        worker_notified = false
      where id = wo.id;
      -- notify_worker_new_job() se charge de la notification et de la
      -- remise à zéro des compteurs pour le nouveau travailleur.
    else
      update work_orders set response_escalated = true where id = wo.id;

      select count(*) into v_admin_count from users where is_admin = true and email is not null;
      if v_admin_count > 0 then
        perform net.http_post(
          url := 'https://kdmwfbcziokygfcmjxeq.supabase.co/functions/v1/handle-worker-job-assigned',
          body := jsonb_build_object('work_order_id', wo.id, 'notification_type', 'all_declined'),
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR',
            'apikey', 'sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR'
          )
        );
      end if;
    end if;
  end loop;
end;
$$;

select cron.schedule('worker-response-timeouts', '*/15 * * * *', $$select process_worker_response_timeouts()$$);

-- ============================================================
-- ORCHESTRATEUR DU CYCLE DE RÉPARATION
-- ============================================================
-- Surveille le cycle complet (reçue -> diagnostic -> travailleur
-- assigné -> intervention -> preuve -> confirmation du locataire) et
-- journalise (audit_log, dédupliqué par fenêtre glissante) tout
-- dossier resté trop longtemps dans une étape, pour qu'un humain le
-- retrouve dans le centre de commandement plutôt que de le perdre.
create or replace function flag_stuck_repair_cases()
returns void language plpgsql security definer set search_path = public as $$
declare
  r record;
begin
  -- 1. Reçue depuis plus de 2 jours sans catégorisation IA.
  for r in
    select id, description from service_requests
    where status = 'open' and ai_category is null
    and created_at <= now() - interval '2 days'
  loop
    insert into audit_log (actor_type, action, entity_type, entity_id, details)
    select 'system', 'repair_case.stuck_no_diagnosis', 'service_requests', r.id, jsonb_build_object('description', r.description)
    where not exists (
      select 1 from audit_log where entity_type = 'service_requests' and entity_id = r.id
      and action = 'repair_case.stuck_no_diagnosis' and created_at >= now() - interval '2 days'
    );
  end loop;

  -- 2. Diagnostiquée mais aucun travailleur assigné (3 jours, 1 jour si urgent/sécurité).
  for r in
    select sr.id, sr.description
    from service_requests sr
    where sr.status = 'open' and sr.ai_category is not null
    and not exists (select 1 from work_orders wo where wo.service_request_id = sr.id and wo.status <> 'cancelled')
    and sr.created_at <= now() - (case when coalesce(sr.safety_override, false) or sr.ai_urgency = 'urgence' then interval '1 day' else interval '3 days' end)
  loop
    insert into audit_log (actor_type, action, entity_type, entity_id, details)
    select 'system', 'repair_case.stuck_no_worker_assigned', 'service_requests', r.id, jsonb_build_object('description', r.description)
    where not exists (
      select 1 from audit_log where entity_type = 'service_requests' and entity_id = r.id
      and action = 'repair_case.stuck_no_worker_assigned' and created_at >= now() - interval '1 day'
    );
  end loop;

  -- 3. Travailleur a accepté (status "in_progress") mais le travail
  --    n'est toujours pas complété 5 jours plus tard.
  for r in
    select id, description from work_orders
    where status = 'in_progress' and worker_response = 'accepted'
    and worker_response_at <= now() - interval '5 days'
  loop
    insert into audit_log (actor_type, action, entity_type, entity_id, details)
    select 'system', 'repair_case.stuck_not_started', 'work_orders', r.id, jsonb_build_object('description', r.description)
    where not exists (
      select 1 from audit_log where entity_type = 'work_orders' and entity_id = r.id
      and action = 'repair_case.stuck_not_started' and created_at >= now() - interval '2 days'
    );
  end loop;

  -- 4. Dépense sans reçu depuis plus de 5 jours.
  for r in
    select id, description from expenses
    where receipt_document_id is null
    and expense_date <= current_date - interval '5 days'
  loop
    insert into audit_log (actor_type, action, entity_type, entity_id, details)
    select 'system', 'repair_case.stuck_missing_receipt', 'expenses', r.id, jsonb_build_object('description', r.description)
    where not exists (
      select 1 from audit_log where entity_type = 'expenses' and entity_id = r.id
      and action = 'repair_case.stuck_missing_receipt' and created_at >= now() - interval '2 days'
    );
  end loop;

  -- 5. Complété, en attente de confirmation du locataire depuis plus de
  --    3 jours : un seul rappel envoyé. Après 7 jours sans réponse, on
  --    ferme automatiquement le dossier plutôt que de le laisser en
  --    attente indéfiniment (le locataire ne perd rien : il peut
  --    toujours rouvrir une nouvelle demande si besoin).
  for r in
    select wo.id, wo.description, wo.tenant_confirmation_sent_at, wo.tenant_reminder_sent, sr.id as service_request_id, sr.tenant_id
    from work_orders wo
    join service_requests sr on sr.id = wo.service_request_id
    where wo.status = 'completed' and coalesce(wo.tenant_confirmed, false) = false
    and wo.tenant_confirmation_sent_at is not null
    and wo.tenant_confirmation_sent_at <= now() - interval '7 days'
  loop
    update work_orders set tenant_confirmed = true, tenant_confirmation_note = 'Fermé automatiquement après 7 jours sans réponse du locataire.' where id = r.id;
    update service_requests set status = 'closed' where id = r.service_request_id;
    insert into audit_log (actor_type, action, entity_type, entity_id, details)
    values ('system', 'repair_case.auto_closed_no_tenant_response', 'work_orders', r.id, jsonb_build_object('description', r.description));
  end loop;

  for r in
    select wo.id, wo.description
    from work_orders wo
    where wo.status = 'completed' and coalesce(wo.tenant_confirmed, false) = false
    and wo.tenant_confirmation_sent_at is not null
    and wo.tenant_confirmation_sent_at <= now() - interval '3 days'
    and coalesce(wo.tenant_reminder_sent, false) = false
  loop
    perform net.http_post(
      url := 'https://kdmwfbcziokygfcmjxeq.supabase.co/functions/v1/handle-tenant-confirmation',
      body := jsonb_build_object('action', 'send_reminder', 'work_order_id', r.id),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR',
        'apikey', 'sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR'
      )
    );
    update work_orders set tenant_reminder_sent = true where id = r.id;

    insert into audit_log (actor_type, action, entity_type, entity_id, details)
    select 'system', 'repair_case.stuck_no_tenant_confirmation', 'work_orders', r.id, jsonb_build_object('description', r.description)
    where not exists (
      select 1 from audit_log where entity_type = 'work_orders' and entity_id = r.id
      and action = 'repair_case.stuck_no_tenant_confirmation' and created_at >= now() - interval '2 days'
    );
  end loop;
end;
$$;

select cron.schedule('daily-flag-stuck-repair-cases', '0 12 * * *', $$select flag_stuck_repair_cases()$$);

-- ============================================================
-- DÉCISION D'APPROBATION — ferme automatiquement la boucle
-- ============================================================
-- Quand le propriétaire approuve ou refuse une dépense (table
-- approvals), déclenche automatiquement la suite :
--   approuvée -> avise le travailleur (mandat) + avise le locataire
--   refusée   -> annule le work_order + avise le locataire
-- Un refus ne doit jamais fermer le dossier silencieusement : la
-- demande est réouverte pour réévaluation (nouvelle soumission,
-- solution alternative) avec une échéance de suivi, plus courte si
-- le problème était urgent/sécuritaire.
alter table service_requests add column if not exists pending_reassessment boolean default false;
alter table service_requests add column if not exists reassessment_due date;
alter table approvals add column if not exists rejection_note text;

create or replace function handle_approval_decision()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_token uuid;
  v_service_request_id uuid;
  v_urgent boolean;
  v_days int;
begin
  if old.status = 'pending' and new.status = 'approved' then
    v_token := gen_random_uuid();
    update work_orders set
      worker_notified = true,
      worker_notified_at = now(),
      worker_response = 'pending',
      worker_response_token = v_token,
      worker_response_note = null,
      response_reminder_sent = false,
      response_escalated = false
    where id = new.work_order_id;

    perform net.http_post(
      url := 'https://kdmwfbcziokygfcmjxeq.supabase.co/functions/v1/handle-worker-job-assigned',
      body := jsonb_build_object('work_order_id', new.work_order_id, 'response_token', v_token, 'notification_type', 'assigned'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR',
        'apikey', 'sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR'
      )
    );

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

    -- Le refus ne ferme pas le dossier : la demande redevient "open"
    -- (réapparaît dans la file admin pour une autre soumission/solution)
    -- avec une échéance de réévaluation plus courte si c'était urgent.
    select wo.service_request_id,
           coalesce(sr.safety_override, false) or coalesce(sr.ai_urgency in ('urgence', 'élevé'), false)
      into v_service_request_id, v_urgent
    from work_orders wo
    left join service_requests sr on sr.id = wo.service_request_id
    where wo.id = new.work_order_id;

    v_days := case when v_urgent then 1 else 3 end;

    if v_service_request_id is not null then
      update service_requests set
        status = 'open',
        pending_reassessment = true,
        reassessment_due = current_date + v_days
      where id = v_service_request_id;
    end if;

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
      jsonb_build_object('work_order_id', new.work_order_id, 'requested_amount', new.requested_amount, 'reassessment_due', current_date + v_days));
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
-- Qualité et suivi de l'annonce : distincte de toute logique
-- d'augmentation de loyer sur bail existant (voir garde-fou dans
-- generate-listing — jamais de suggestion basée sur le marché pour un
-- renouvellement, seulement pour une vraie vacance).
alter table units add column if not exists amenities text;
alter table units add column if not exists listing_published_at timestamptz;
alter table units add column if not exists listing_low_interest boolean default false;
alter table units add column if not exists listing_quality_score int;
alter table units add column if not exists listing_quality_notes text;
alter table units add column if not exists listing_description_short text;

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
    new.listing_published_at := now();
    new.listing_low_interest := false;
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

-- Alerte si peu de demandes de visite après quelques jours — visible
-- par l'admin plutôt que de laisser une annonce stagner sans action.
create or replace function flag_stale_listings()
returns void language plpgsql security definer set search_path = public as $$
begin
  update units u set listing_low_interest = true
  where u.status in ('available', 'soon_available')
    and u.listing_published_at is not null
    and u.listing_published_at <= now() - interval '5 days'
    and coalesce(u.listing_low_interest, false) = false
    and (
      select count(*) from inquiries i
      where i.unit_id = u.id and i.type = 'visite' and i.created_at >= u.listing_published_at
    ) < 2;
end;
$$;

select cron.schedule('daily-flag-stale-listings', '0 14 * * *', $$select flag_stale_listings()$$);

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
