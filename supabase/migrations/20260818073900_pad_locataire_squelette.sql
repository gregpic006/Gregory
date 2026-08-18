-- ============================================================
-- PRÉLÈVEMENT AUTOMATIQUE DES LOYERS (PAD locataire) — squelette
-- ============================================================
-- Distinct du pad_authorizations existant (schema.sql) qui sert à
-- Portail pour prélever ses PROPRES frais de gestion auprès du
-- PROPRIÉTAIRE — ceci concerne le LOYER, prélevé auprès du LOCATAIRE,
-- rattaché au bail (leases), pas au propriétaire.
--
-- Aucun processeur de paiement n'est branché ici volontairement :
-- l'intégration réelle (Stripe ACSS Debit ou autre) sera complétée par
-- l'équipe technique du client (TWIM). Cette migration ne fait que
-- poser la structure de données et une visibilité admin minimale
-- (bascule manuelle de statut, comme le pad_authorizations existant),
-- pour que cette équipe ait une base déjà prête à brancher plutôt que
-- de repartir de zéro. `processor`/`processor_customer_id`/
-- `processor_mandate_id` sont volontairement génériques (pas de colonne
-- Stripe-spécifique) pour ne pas figer un choix technique qui ne nous
-- appartient plus.

create table if not exists tenant_pad_authorizations (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid references leases(id) on delete cascade,
  tenant_id uuid references tenants(id) on delete cascade,
  status text default 'pending' check (status in ('pending', 'active', 'revoked')),
  consented_at timestamptz,
  consent_method text,
  processor text,
  processor_customer_id text,
  processor_mandate_id text,
  revoked_at timestamptz,
  notes text,
  created_at timestamptz default now(),
  unique (lease_id)
);

alter table tenant_pad_authorizations enable row level security;

create policy "admin manages tenant pad authorizations" on tenant_pad_authorizations for all
  using (auth_is_admin()) with check (auth_is_admin());
create policy "owner views own tenants pad authorizations" on tenant_pad_authorizations for select
  using (lease_id in (select owned_lease_ids()));
create policy "tenant views own pad authorization" on tenant_pad_authorizations for select
  using (tenant_id = auth_tenant_id());

-- État de perception par échéance de loyer (table payments existante) —
-- même vocabulaire que invoices.collection_status pour rester cohérent,
-- mais 'manual' par défaut ici puisque rien n'est automatisé tant que le
-- processeur n'est pas branché (contrairement à 'pending' qui impliquerait
-- qu'une tentative automatique est prévue).
alter table payments add column if not exists collection_status text default 'manual'
  check (collection_status in ('manual', 'scheduled', 'collected', 'failed'));
alter table payments add column if not exists processor_charge_id text;
alter table payments add column if not exists collection_error text;
