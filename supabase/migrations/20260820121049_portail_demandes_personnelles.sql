-- Loi 25 volet 4 : jusqu'ici, une demande d'accès/rectification/
-- effacement ne pouvait être créée que par un admin (après qu'un
-- propriétaire ou locataire l'ait contactée par un autre moyen).
-- Permet maintenant à un propriétaire ou locataire de soumettre
-- lui-même sa propre demande depuis son portail. status doit rester
-- 'received' à la création — seul l'admin peut faire progresser une
-- demande (aucune policy UPDATE n'est accordée ici).
create policy "owner submit own data request" on personal_data_requests for insert
  with check (subject_type = 'owner' and subject_id = auth_owner_id() and status = 'received');
create policy "tenant submit own data request" on personal_data_requests for insert
  with check (subject_type = 'tenant' and subject_id = auth_tenant_id() and status = 'received');

create policy "owner read own data requests" on personal_data_requests for select
  using (subject_type = 'owner' and subject_id = auth_owner_id());
create policy "tenant read own data requests" on personal_data_requests for select
  using (subject_type = 'tenant' and subject_id = auth_tenant_id());
