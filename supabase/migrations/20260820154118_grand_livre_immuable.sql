-- Comptabilité V1 (brief TWIM) : "Aucune suppression silencieuse;
-- corrections par écriture d'ajustement." Le grand livre n'avait pas
-- l'équivalent du trigger d'immuabilité déjà en place sur audit_log —
-- rien n'empêchait structurellement une future ligne de code de
-- modifier/supprimer une écriture déjà posée (la policy RLS "admin
-- full access" ne protège rien contre service_role, qui contourne RLS
-- entièrement). Même garde-fou, appliqué aux deux tables du grand
-- livre : toute correction doit passer par une nouvelle écriture
-- d'ajustement (create_manual_journal_entry), jamais par une
-- modification de l'existant.
create or replace function prevent_gl_mutation() returns trigger as $$
begin
  raise exception 'Le grand livre est immuable : % non permis sur une écriture existante — corrige par une écriture d''ajustement', TG_OP;
end;
$$ language plpgsql;

create trigger gl_journal_entries_immutable
  before update or delete on gl_journal_entries
  for each row execute function prevent_gl_mutation();

create trigger gl_journal_lines_immutable
  before update or delete on gl_journal_lines
  for each row execute function prevent_gl_mutation();
