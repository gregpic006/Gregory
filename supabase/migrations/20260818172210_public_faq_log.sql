-- Journal de limitation de débit pour la nouvelle FAQ publique (question libre,
-- répondue par IA). Table dédiée plutôt que de réutiliser public_submission_log
-- (formulaires visite/mandat) pour ne pas mélanger deux limites différentes :
-- une question FAQ est un geste beaucoup plus léger et anonyme qu'un envoi de
-- formulaire, donc la limite est plus généreuse (voir handle-public-faq).
create table public_faq_log (
  id uuid primary key default gen_random_uuid(),
  ip_address text,
  created_at timestamptz default now()
);
-- Pas de policy RLS ouverte : écrit/lu uniquement par la fonction
-- Edge "handle-public-faq" (service_role).

alter table public_faq_log enable row level security;

create index idx_public_faq_log_ip_created on public_faq_log(ip_address, created_at);

-- Purge des entrées de plus de 24h pour éviter que la table ne grossisse indéfiniment.
select cron.schedule(
  'purge-public-faq-log',
  '0 4 * * *',
  $$ delete from public_faq_log where created_at < now() - interval '24 hours' $$
);
