-- Complète 20260820121049 : les propriétaires et locataires pouvaient
-- déjà soumettre leur propre demande d'accès/rectification/effacement
-- depuis leur portail ; les travailleurs ne le pouvaient pas encore.
create policy "worker submit own data request" on personal_data_requests for insert
  with check (
    subject_type = 'worker'
    and subject_id in (select id from workers where user_id = auth.uid())
    and status = 'received'
  );
create policy "worker read own data requests" on personal_data_requests for select
  using (subject_type = 'worker' and subject_id in (select id from workers where user_id = auth.uid()));
