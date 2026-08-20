-- Loi 25 volet 3 (article 12.1) : journal des décisions prises
-- EXCLUSIVEMENT par un traitement automatisé, sans intervention
-- humaine — avec les facteurs qui ont mené à la décision, un avis
-- consultable par la personne concernée, et un mécanisme pour demander
-- une révision humaine. Couvre les 4 traitements identifiés comme
-- "décide, sans humain" :
--   1. Réparation sous/au-dessus le plafond du propriétaire (proceed
--      automatique OU création d'une approbation en attente — les deux
--      sont des décisions, pas seulement la seconde).
--   2. Détection d'anomalies financières (purement déterministe).
--   3. Réassignation automatique d'un travailleur après délai de
--      non-réponse.
--   4. Escalade d'un signal d'insatisfaction (le seuil est
--      déterministe — voir analyze-satisfaction-signal.ts — seule la
--      classification de ton vient de l'IA).
create table automated_decisions (
  id uuid primary key default gen_random_uuid(),
  decision_type text not null,
  subject_type text not null check (subject_type in ('owner', 'tenant', 'worker')),
  subject_id uuid not null,
  entity_type text,
  entity_id uuid,
  summary text not null,
  factors jsonb not null default '{}'::jsonb,
  decided_at timestamptz default now(),
  review_requested_at timestamptz,
  review_note text,
  review_outcome text check (review_outcome is null or review_outcome in ('maintenue', 'annulee')),
  review_response text,
  reviewed_at timestamptz,
  reviewed_by uuid references users(id)
);

alter table automated_decisions enable row level security;

create policy "admin full access automated_decisions" on automated_decisions
  for all using (auth_is_admin()) with check (auth_is_admin());

create policy "own automated decisions as owner" on automated_decisions for select
  using (subject_type = 'owner' and subject_id = auth_owner_id());
create policy "own automated decisions as tenant" on automated_decisions for select
  using (subject_type = 'tenant' and subject_id = auth_tenant_id());
create policy "own automated decisions as worker" on automated_decisions for select
  using (subject_type = 'worker' and subject_id in (select id from workers where user_id = auth.uid()));

-- La personne concernée ne peut que DEMANDER une révision (deux
-- colonnes) — jamais modifier la décision elle-même, son résultat, ou
-- la réponse de l'admin. Même garde-fou par trigger que pour
-- approvals/inquiries (RLS seule ne distingue pas les colonnes).
create policy "request review as owner" on automated_decisions for update
  using (subject_type = 'owner' and subject_id = auth_owner_id());
create policy "request review as tenant" on automated_decisions for update
  using (subject_type = 'tenant' and subject_id = auth_tenant_id());
create policy "request review as worker" on automated_decisions for update
  using (subject_type = 'worker' and subject_id in (select id from workers where user_id = auth.uid()));

create or replace function restrict_automated_decisions_subject_update()
returns trigger language plpgsql as $$
begin
  if auth.role() = 'authenticated' and not auth_is_admin() then
    if (to_jsonb(new) - array['review_requested_at', 'review_note'])
       is distinct from (to_jsonb(old) - array['review_requested_at', 'review_note']) then
      raise exception 'Modification non autorisée sur cette décision';
    end if;
  end if;
  return new;
end;
$$;
create trigger restrict_automated_decisions_subject_update_trigger
  before update on automated_decisions
  for each row execute function restrict_automated_decisions_subject_update();

create index idx_automated_decisions_subject on automated_decisions(subject_type, subject_id, decided_at desc);
create index idx_automated_decisions_review_pending on automated_decisions(review_requested_at) where review_requested_at is not null and review_outcome is null;

-- ============================================================
-- 1. Réparations sous/au-dessus le plafond — étend le déclencheur
--    existant (check_work_order_approval) pour journaliser les DEUX
--    issues, pas seulement la création d'une approbation en attente.
-- ============================================================
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

    insert into automated_decisions (decision_type, subject_type, subject_id, entity_type, entity_id, summary, factors)
    values ('work_order_approval_required', 'owner', v_owner_id, 'work_orders', NEW.id,
      'Réparation soumise à votre approbation car son coût estimé dépasse votre plafond.',
      jsonb_build_object('estimated_cost', NEW.estimated_cost, 'spending_cap', v_cap, 'regle', 'estimated_cost > spending_cap'));
  elsif v_owner_id is not null then
    insert into automated_decisions (decision_type, subject_type, subject_id, entity_type, entity_id, summary, factors)
    values ('work_order_auto_proceed', 'owner', v_owner_id, 'work_orders', NEW.id,
      'Réparation lancée automatiquement, sans votre approbation, car son coût estimé respecte votre plafond.',
      jsonb_build_object('estimated_cost', NEW.estimated_cost, 'spending_cap', v_cap, 'regle', 'estimated_cost <= spending_cap ou non estime'));
  end if;
  return NEW;
end;
$$;

-- ============================================================
-- 2. Anomalies financières — même fonction, ajoute une ligne de
--    journal miroir de chaque insertion dans financial_anomalies.
-- ============================================================
create or replace function detect_financial_anomalies()
returns void language plpgsql security definer set search_path = public as $$
begin
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

  insert into automated_decisions (decision_type, subject_type, subject_id, entity_type, entity_id, summary, factors)
  select 'financial_anomaly_facture_dupliquee', 'owner', b.owner_id, 'expenses', e1.id,
    'Anomalie signalée automatiquement : deux dépenses similaires pour le même immeuble à peu de jours d''écart.',
    jsonb_build_object('amount', e1.amount, 'other_expense_id', e2.id, 'jours_ecart', abs(e1.expense_date - e2.expense_date))
  from expenses e1
  join expenses e2 on e2.building_id = e1.building_id
    and e2.amount = e1.amount and e2.id <> e1.id
    and abs(e1.expense_date - e2.expense_date) <= 3
  join buildings b on b.id = e1.building_id
  where e1.id < e2.id
    and exists (select 1 from financial_anomalies fa where fa.type = 'facture_dupliquee' and fa.related_expense_id = e1.id and fa.status <> 'dismissed')
    and not exists (select 1 from automated_decisions ad where ad.decision_type = 'financial_anomaly_facture_dupliquee' and ad.entity_id = e1.id);

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

  insert into automated_decisions (decision_type, subject_type, subject_id, entity_type, entity_id, summary, factors)
  select 'financial_anomaly_depassement_cout', 'owner', b.owner_id, 'expenses', e.id,
    'Anomalie signalée automatiquement : coût final supérieur de plus de 20% à l''estimation.',
    jsonb_build_object('amount', e.amount, 'estimated_cost', wo.estimated_cost, 'work_order_id', wo.id)
  from expenses e
  join work_orders wo on wo.id = e.work_order_id
  join buildings b on b.id = e.building_id
  where wo.estimated_cost is not null and e.amount > wo.estimated_cost * 1.2
    and exists (select 1 from financial_anomalies fa where fa.type = 'depassement_cout' and fa.related_expense_id = e.id and fa.status <> 'dismissed')
    and not exists (select 1 from automated_decisions ad where ad.decision_type = 'financial_anomaly_depassement_cout' and ad.entity_id = e.id);

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

  insert into automated_decisions (decision_type, subject_type, subject_id, entity_type, entity_id, summary, factors)
  select 'financial_anomaly_loyer_montant_incorrect', 'owner', b.owner_id, 'payments', p.id,
    'Anomalie signalée automatiquement : montant du paiement différent du loyer prévu au bail.',
    jsonb_build_object('amount', p.amount, 'monthly_rent', l.monthly_rent, 'lease_id', l.id)
  from payments p
  join leases l on l.id = p.lease_id
  join units u on u.id = l.unit_id
  join buildings b on b.id = u.building_id
  where p.status = 'paid' and p.amount <> l.monthly_rent
    and exists (select 1 from financial_anomalies fa where fa.type = 'loyer_montant_incorrect' and fa.related_payment_id = p.id and fa.status <> 'dismissed')
    and not exists (select 1 from automated_decisions ad where ad.decision_type = 'financial_anomaly_loyer_montant_incorrect' and ad.entity_id = p.id);

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

  insert into automated_decisions (decision_type, subject_type, subject_id, entity_type, entity_id, summary, factors)
  select 'financial_anomaly_recu_manquant', 'owner', b.owner_id, 'expenses', e.id,
    'Anomalie signalée automatiquement : dépense enregistrée sans facture/reçu joint.',
    jsonb_build_object('amount', e.amount)
  from expenses e
  join buildings b on b.id = e.building_id
  where e.receipt_document_id is null and e.amount > 50
    and exists (select 1 from financial_anomalies fa where fa.type = 'recu_manquant' and fa.related_expense_id = e.id and fa.status <> 'dismissed')
    and not exists (select 1 from automated_decisions ad where ad.decision_type = 'financial_anomaly_recu_manquant' and ad.entity_id = e.id);
end;
$$;

-- ============================================================
-- 3. Réassignation automatique d'un travailleur après délai
-- ============================================================
create or replace function process_worker_response_timeouts()
returns void language plpgsql security definer set search_path = public as $$
declare
  wo record;
  v_next_worker_id uuid;
  v_admin_count int;
begin
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
    from worker_verification_status
    where specialty is not distinct from wo.specialty
    and id <> wo.worker_id
    and not (id = any(coalesce(wo.declined_worker_ids, '{}')))
    and coalesce(active, true)
    and not missing_rbq_license
    and not rbq_expired
    and not missing_insurance_doc
    and not insurance_expired
    order by random()
    limit 1;

    if v_next_worker_id is not null then
      insert into automated_decisions (decision_type, subject_type, subject_id, entity_type, entity_id, summary, factors)
      values ('worker_reassigned_timeout', 'worker', wo.worker_id, 'work_orders', wo.id,
        'Ce mandat vous a été retiré automatiquement et réassigné à un autre travailleur, faute de réponse dans le délai prévu.',
        jsonb_build_object('delai_heures', 2, 'nouveau_travailleur_id', v_next_worker_id));

      update work_orders set
        declined_worker_ids = array_append(coalesce(declined_worker_ids, '{}'), worker_id),
        worker_id = v_next_worker_id,
        worker_notified = false
      where id = wo.id;
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
