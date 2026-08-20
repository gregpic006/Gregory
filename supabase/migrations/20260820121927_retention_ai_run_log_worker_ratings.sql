-- Loi 25 volet 5 : deux écarts identifiés dans l'audit — des tables
-- accumulaient indéfiniment sans durée de conservation définie.
-- ai_run_log : trace d'exécution technique (quel prompt, quel modèle,
-- combien de temps) utile pour diagnostiquer, mais input_summary/
-- output_summary peuvent contenir des extraits de renseignements
-- personnels. 12 mois est amplement suffisant pour le diagnostic —
-- aucun cas d'usage n'exige de le garder plus longtemps.
create or replace function purge_old_ai_run_log() returns void language sql as $$
  delete from ai_run_log where created_at < now() - interval '12 months';
$$;
select cron.schedule('purge-old-ai-run-log', '0 5 1 * *', $$select purge_old_ai_run_log()$$);

-- worker_ratings : la note (stars) sert un besoin métier permanent
-- (réputation du travailleur, moyenne affichée) et reste conservée.
-- Le commentaire libre est ce qui porte le risque — un locataire ou
-- propriétaire peut y écrire des détails personnels sans lien avec
-- la note elle-même. Anonymisé après 24 mois plutôt que la ligne
-- entière supprimée, pour ne pas fausser la moyenne historique.
create or replace function purge_old_worker_rating_comments() returns void language sql as $$
  update worker_ratings
  set comment = null
  where comment is not null and created_at < now() - interval '24 months';
$$;
select cron.schedule('purge-old-worker-rating-comments', '0 5 1 * *', $$select purge_old_worker_rating_comments()$$);
