-- ============================================================
-- MODULE COMPTABLE — grand livre à partie double
-- ============================================================
-- Va au-delà de la détection d'anomalies déjà en place (financial_anomalies) :
-- un vrai plan de comptes par propriétaire, des écritures à partie
-- double (chaque écriture = au moins un débit + un crédit qui
-- s'équilibrent), postées automatiquement à partir des événements déjà
-- suivis ailleurs (loyer perçu, dépense créée, facture Portail émise),
-- et une balance de vérification par propriétaire.
--
-- Portée volontairement MVP : pas de périodes comptables/clôture, pas de
-- multi-devises, pas d'état des résultats/bilan formatés — seulement le
-- plan de comptes, le journal, et la balance de vérification, qui sont
-- déjà suffisants pour qu'un propriétaire ou son comptable externe
-- exporte et retravaille les chiffres.

create table if not exists gl_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references owners(id) on delete cascade,
  code text not null,
  name text not null,
  account_type text not null check (account_type in ('actif', 'passif', 'capitaux_propres', 'revenu', 'depense')),
  created_at timestamptz default now(),
  unique (owner_id, code)
);

create table if not exists gl_journal_entries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references owners(id) on delete cascade,
  entry_date date not null default current_date,
  description text not null,
  source_type text check (source_type in ('payment', 'expense', 'invoice', 'manual')),
  source_id uuid,
  created_by text default 'system',
  created_at timestamptz default now()
);

create table if not exists gl_journal_lines (
  id uuid primary key default gen_random_uuid(),
  journal_entry_id uuid references gl_journal_entries(id) on delete cascade,
  account_id uuid references gl_accounts(id),
  debit numeric(10,2) not null default 0,
  credit numeric(10,2) not null default 0,
  check (debit >= 0 and credit >= 0),
  check (not (debit > 0 and credit > 0))
);

create index if not exists idx_gl_journal_lines_entry on gl_journal_lines (journal_entry_id);
create index if not exists idx_gl_journal_lines_account on gl_journal_lines (account_id);
create index if not exists idx_gl_journal_entries_owner on gl_journal_entries (owner_id);

alter table gl_accounts enable row level security;
create policy "admin manages gl_accounts" on gl_accounts for all
  using (auth_is_admin()) with check (auth_is_admin());
create policy "owner views own gl_accounts" on gl_accounts for select
  using (owner_id = auth_owner_id());

alter table gl_journal_entries enable row level security;
create policy "admin manages gl_journal_entries" on gl_journal_entries for all
  using (auth_is_admin()) with check (auth_is_admin());
create policy "owner views own gl_journal_entries" on gl_journal_entries for select
  using (owner_id = auth_owner_id());

alter table gl_journal_lines enable row level security;
create policy "admin manages gl_journal_lines" on gl_journal_lines for all
  using (auth_is_admin()) with check (auth_is_admin());
create policy "owner views own gl_journal_lines" on gl_journal_lines for select
  using (journal_entry_id in (select id from gl_journal_entries where owner_id = auth_owner_id()));

-- Plan de comptes par défaut — les catégories de dépenses reprennent
-- exactement la liste déjà utilisée par expenses.category (voir
-- edge-function-parse-expense-receipt.ts) pour rester cohérent avec le
-- reste du système plutôt que d'inventer une deuxième taxonomie.
create or replace function seed_default_gl_accounts(p_owner_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into gl_accounts (owner_id, code, name, account_type) values
    (p_owner_id, '1000', 'Banque', 'actif'),
    (p_owner_id, '2000', 'Comptes à payer', 'passif'),
    (p_owner_id, '4000', 'Revenus de loyers', 'revenu'),
    (p_owner_id, '5000', 'Dépenses — Plomberie', 'depense'),
    (p_owner_id, '5010', 'Dépenses — Électricité', 'depense'),
    (p_owner_id, '5020', 'Dépenses — CVAC', 'depense'),
    (p_owner_id, '5030', 'Dépenses — Serrurerie', 'depense'),
    (p_owner_id, '5040', 'Dépenses — Structure', 'depense'),
    (p_owner_id, '5050', 'Dépenses — Peinture', 'depense'),
    (p_owner_id, '5060', 'Dépenses — Ménage', 'depense'),
    (p_owner_id, '5070', 'Dépenses — Assurance', 'depense'),
    (p_owner_id, '5080', 'Dépenses — Taxes municipales', 'depense'),
    (p_owner_id, '5090', 'Dépenses — Utilities', 'depense'),
    (p_owner_id, '5100', 'Dépenses — Administratif', 'depense'),
    (p_owner_id, '5110', 'Dépenses — Autre', 'depense'),
    (p_owner_id, '5200', 'Frais de gestion Portail', 'depense')
  on conflict (owner_id, code) do nothing;
end;
$$;

create or replace function seed_default_gl_accounts_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform seed_default_gl_accounts(NEW.id);
  return NEW;
end;
$$;

drop trigger if exists on_owner_insert_seed_gl_accounts on owners;
create trigger on_owner_insert_seed_gl_accounts after insert on owners
  for each row execute function seed_default_gl_accounts_trigger();

-- Rattrapage pour les propriétaires déjà créés avant cette migration.
do $$
declare r record;
begin
  for r in select id from owners loop
    perform seed_default_gl_accounts(r.id);
  end loop;
end $$;

-- Écriture automatique : loyer perçu (payments.status → 'paid').
-- Débit Banque / Crédit Revenus de loyers. Le check TG_OP/OLD.status
-- évite un double-comptage si un paiement déjà 'paid' est retouché
-- (ex: correction du montant) sans qu'un nouveau paiement soit
-- réellement entré.
create or replace function post_payment_to_gl()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_owner_id uuid;
  v_bank_account_id uuid;
  v_revenue_account_id uuid;
  v_entry_id uuid;
  v_amount numeric(10,2);
begin
  if NEW.status is distinct from 'paid' then
    return NEW;
  end if;
  if TG_OP = 'UPDATE' and OLD.status = 'paid' then
    return NEW;
  end if;

  select b.owner_id into v_owner_id
  from leases l join units u on u.id = l.unit_id join buildings b on b.id = u.building_id
  where l.id = NEW.lease_id;
  if v_owner_id is null then return NEW; end if;

  v_amount := coalesce(NEW.amount_received, NEW.amount);
  if v_amount is null or v_amount <= 0 then return NEW; end if;

  select id into v_bank_account_id from gl_accounts where owner_id = v_owner_id and code = '1000';
  select id into v_revenue_account_id from gl_accounts where owner_id = v_owner_id and code = '4000';
  if v_bank_account_id is null or v_revenue_account_id is null then return NEW; end if;

  insert into gl_journal_entries (owner_id, entry_date, description, source_type, source_id, created_by)
  values (v_owner_id, coalesce(NEW.paid_date, current_date), 'Loyer perçu', 'payment', NEW.id, 'system')
  returning id into v_entry_id;

  insert into gl_journal_lines (journal_entry_id, account_id, debit, credit) values
    (v_entry_id, v_bank_account_id, v_amount, 0),
    (v_entry_id, v_revenue_account_id, 0, v_amount);

  return NEW;
end;
$$;

drop trigger if exists on_payment_insert_post_gl on payments;
drop trigger if exists on_payment_update_post_gl on payments;
create trigger on_payment_insert_post_gl after insert on payments
  for each row execute function post_payment_to_gl();
create trigger on_payment_update_post_gl after update on payments
  for each row execute function post_payment_to_gl();

-- Écriture automatique : dépense créée. Débit compte de dépense (selon
-- expenses.category) / Crédit Banque.
create or replace function post_expense_to_gl()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_owner_id uuid;
  v_bank_account_id uuid;
  v_expense_account_id uuid;
  v_entry_id uuid;
  v_code text;
begin
  select owner_id into v_owner_id from buildings where id = NEW.building_id;
  if v_owner_id is null then return NEW; end if;

  v_code := case NEW.category
    when 'plomberie' then '5000' when 'electricite' then '5010' when 'cvac' then '5020'
    when 'serrurerie' then '5030' when 'structure' then '5040' when 'peinture' then '5050'
    when 'menage' then '5060' when 'assurance' then '5070' when 'taxes_municipales' then '5080'
    when 'utilities' then '5090' when 'administratif' then '5100' else '5110'
  end;

  select id into v_expense_account_id from gl_accounts where owner_id = v_owner_id and code = v_code;
  select id into v_bank_account_id from gl_accounts where owner_id = v_owner_id and code = '1000';
  if v_expense_account_id is null or v_bank_account_id is null or NEW.amount is null or NEW.amount <= 0 then return NEW; end if;

  insert into gl_journal_entries (owner_id, entry_date, description, source_type, source_id, created_by)
  values (v_owner_id, coalesce(NEW.expense_date, current_date), coalesce(NEW.description, 'Dépense'), 'expense', NEW.id, 'system')
  returning id into v_entry_id;

  insert into gl_journal_lines (journal_entry_id, account_id, debit, credit) values
    (v_entry_id, v_expense_account_id, NEW.amount, 0),
    (v_entry_id, v_bank_account_id, 0, NEW.amount);

  return NEW;
end;
$$;

drop trigger if exists on_expense_insert_post_gl on expenses;
create trigger on_expense_insert_post_gl after insert on expenses
  for each row execute function post_expense_to_gl();

-- Écriture automatique : facture Portail émise (invoices). Débit Frais
-- de gestion Portail / Crédit Comptes à payer — la facture n'est pas
-- encore payée au moment de son émission, seulement due.
create or replace function post_invoice_to_gl()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_expense_account_id uuid;
  v_payable_account_id uuid;
  v_entry_id uuid;
begin
  select id into v_expense_account_id from gl_accounts where owner_id = NEW.owner_id and code = '5200';
  select id into v_payable_account_id from gl_accounts where owner_id = NEW.owner_id and code = '2000';
  if v_expense_account_id is null or v_payable_account_id is null or NEW.total_amount is null or NEW.total_amount <= 0 then return NEW; end if;

  insert into gl_journal_entries (owner_id, entry_date, description, source_type, source_id, created_by)
  values (NEW.owner_id, current_date, 'Facture Portail ' || NEW.invoice_number, 'invoice', NEW.id, 'system')
  returning id into v_entry_id;

  insert into gl_journal_lines (journal_entry_id, account_id, debit, credit) values
    (v_entry_id, v_expense_account_id, NEW.total_amount, 0),
    (v_entry_id, v_payable_account_id, 0, NEW.total_amount);

  return NEW;
end;
$$;

drop trigger if exists on_invoice_insert_post_gl on invoices;
create trigger on_invoice_insert_post_gl after insert on invoices
  for each row execute function post_invoice_to_gl();

-- Balance de vérification par propriétaire.
create or replace function gl_trial_balance(p_owner_id uuid)
returns table (code text, name text, account_type text, total_debit numeric, total_credit numeric, balance numeric)
language sql security definer set search_path = public as $$
  select a.code, a.name, a.account_type,
    coalesce(sum(l.debit), 0) as total_debit,
    coalesce(sum(l.credit), 0) as total_credit,
    coalesce(sum(l.debit) - sum(l.credit), 0) as balance
  from gl_accounts a
  left join gl_journal_lines l on l.account_id = a.id
  where a.owner_id = p_owner_id
  group by a.id, a.code, a.name, a.account_type
  order by a.code;
$$;
