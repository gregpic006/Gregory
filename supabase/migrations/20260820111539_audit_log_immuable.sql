-- Loi 25 volet 5 (gouvernance) : le journal d'audit ne doit pas dépendre de
-- la discipline d'un opérateur ou de la clé service_role pour rester fiable.
-- service_role contourne RLS par conception dans Supabase, donc une policy
-- RLS ne suffirait pas ; un trigger BEFORE UPDATE/DELETE, lui, s'applique à
-- tous les rôles sans exception, y compris service_role.
create or replace function prevent_audit_log_mutation() returns trigger as $$
begin
  raise exception 'audit_log est immuable : % non permis sur une ligne existante', TG_OP;
end;
$$ language plpgsql;

create trigger audit_log_immutable
  before update or delete on audit_log
  for each row execute function prevent_audit_log_mutation();
