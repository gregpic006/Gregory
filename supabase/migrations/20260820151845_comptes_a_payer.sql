-- Comptes à payer (A/P) — brief TWIM V1, module "Comptabilité V1". Une
-- facture fournisseur passe par une approbation dédiée AVANT paiement —
-- une question différente de l'approbation "démarrer les travaux"
-- (plafond de dépense sur les work_orders, déjà existante). Ici :
-- "est-ce qu'on paie cette facture reçue ?" — légitimité, montant,
-- rattachement à un mandat existant. Décision opérationnelle du côté
-- Portail (le propriétaire garde visibilité, pas la charge d'approuver
-- chaque facture courante — cohérent avec l'objectif du brief : "sans
-- gérer lui-même les opérations").
create table payables (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references owners(id) on delete cascade,
  building_id uuid references buildings(id),
  work_order_id uuid references work_orders(id),
  vendor_name text not null,
  description text not null,
  amount numeric(10,2) not null check (amount > 0),
  category text,
  due_date date,
  invoice_document_id uuid references documents(id),
  status text default 'pending_approval'
    check (status in ('pending_approval', 'approved', 'rejected', 'paid')),
  approved_by uuid references users(id),
  approved_at timestamptz,
  rejection_note text,
  paid_at timestamptz,
  -- Une fois payée, la facture devient une vraie dépense (déclenche
  -- l'écriture GL via post_expense_to_gl()) — payables n'est PAS
  -- elle-même une source d'écritures comptables, seulement le
  -- contrôle d'approbation en amont.
  expense_id uuid references expenses(id),
  created_at timestamptz default now()
);

alter table payables enable row level security;

create policy "admin manages payables" on payables for all
  using (auth_is_admin()) with check (auth_is_admin());
create policy "owner views own payables" on payables for select
  using (owner_id = auth_owner_id());

create index idx_payables_status on payables(status) where status = 'pending_approval';
create index idx_payables_owner on payables(owner_id);
