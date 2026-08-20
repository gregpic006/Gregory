-- Débours externes (TAL, huissier, avocat) — brief TWIM V1 : "Gestion
-- administrative incluse dans le 6 %. [...] Les débours externes
-- restent au propriétaire. Frais de dépôt, huissier, avocat/
-- professionnel : hors 6 %, sans marge cachée." Ce coût appartient au
-- propriétaire, pas à Portail — jamais absorbé dans les honoraires de
-- gestion, jamais majoré. Toujours rattaché à un bail précis (dossier
-- d'impayé), facturé au coût réel une fois logué.
create table external_disbursements (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references owners(id) on delete cascade,
  building_id uuid references buildings(id),
  lease_id uuid references leases(id) not null,
  tenant_id uuid references tenants(id),
  category text not null check (category in ('depot_tal', 'huissier', 'avocat', 'autre')),
  description text not null,
  amount numeric(10,2) not null check (amount > 0),
  receipt_document_id uuid references documents(id),
  status text default 'a_facturer' check (status in ('a_facturer', 'facture')),
  -- Ligne de dépense réelle créée quand le débours est facturé au
  -- propriétaire (voir ops-api.ts action "mark_disbursement_billed") —
  -- déclenche l'écriture GL comme toute autre dépense, distincte des
  -- honoraires Portail (6 %/10 %).
  expense_id uuid references expenses(id),
  created_at timestamptz default now()
);

alter table external_disbursements enable row level security;

create policy "admin manages external disbursements" on external_disbursements for all
  using (auth_is_admin()) with check (auth_is_admin());
create policy "owner views own external disbursements" on external_disbursements for select
  using (owner_id = auth_owner_id());

create index idx_external_disbursements_lease on external_disbursements(lease_id);
