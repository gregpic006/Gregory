-- =====================================================================
-- LEASE LANE COMMAND CENTER — automatisation planifiée
--
-- C'est ce fichier qui rend le système « vivant » : sans lui, rien ne se
-- synchronise et rien n'est trié. Quatre tâches planifiées :
--
--   toutes les 5 min   → rapatrier courriels / agenda / documents
--   toutes les 10 min  → trier avec l'IA et agir
--   tous les jours 7 h → point du matin par personne
--   dimanche 9 h       → dossier de la réunion hebdomadaire
--
-- PRÉREQUIS (une seule fois, dans le tableau de bord du nouveau projet
-- Supabase) — voir command-center/README.md :
--   1. Database → Extensions : activer `pg_cron` et `pg_net`.
--   2. SQL Editor :
--        select vault.create_secret('<CC_CRON_SECRET>', 'cc_cron_secret');
--        insert into app_settings (key, value)
--        values ('functions_base_url', '"https://<ref>.supabase.co/functions/v1"')
--        on conflict (key) do update set value = excluded.value;
--
-- Sans ces trois valeurs, les tâches sont créées mais ne font rien —
-- volontairement, plutôt que d'échouer en boucle dans les journaux.
-- =====================================================================

-- Un seul endroit qui sait appeler une edge function : l'URL vient des
-- réglages, le secret du coffre. Changer de projet Supabase ne demande
-- donc de modifier qu'une ligne d'app_settings, pas quatre tâches cron.
create or replace function cc_call_function(p_name text, p_body jsonb default '{}'::jsonb)
returns bigint
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_base   text;
  v_secret text;
begin
  select value #>> '{}' into v_base from app_settings where key = 'functions_base_url';
  begin
    select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'cc_cron_secret' limit 1;
  exception when others then
    v_secret := null;
  end;

  -- Sans configuration, on ne tente rien : appeler une URL nulle
  -- remplirait net._http_response d'erreurs toutes les 5 minutes et
  -- masquerait les vraies pannes.
  if v_base is null or v_secret is null then
    return null;
  end if;

  return net.http_post(
    url     := v_base || '/' || p_name,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cc-cron-secret', v_secret),
    body    := p_body,
    timeout_milliseconds := 120000
  );
end;
$$;

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron absent — les tâches planifiées ne sont PAS créées. Active l''extension puis rejoue ce fichier.';
    return;
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_net absent — les tâches planifiées ne sont PAS créées. Active l''extension puis rejoue ce fichier.';
    return;
  end if;

  -- unschedule avant schedule : rejouer la migration doit remplacer les
  -- tâches, pas en empiler des copies.
  perform cron.unschedule(jobname)
    from cron.job
   where jobname in ('cc-sync-google', 'cc-triage-ai', 'cc-digest-daily', 'cc-digest-weekly');

  perform cron.schedule('cc-sync-google', '*/5 * * * *',
    $cmd$ select public.cc_call_function('cc-google-sync'); $cmd$);

  -- Décalé de 10 minutes derrière la synchro plutôt que simultané : le
  -- tri travaille ainsi sur des courriels déjà rapatriés.
  perform cron.schedule('cc-triage-ai', '2-59/10 * * * *',
    $cmd$ select public.cc_call_function('cc-ai-triage'); $cmd$);

  -- Heures en UTC. 11:00 UTC = 7 h à Montréal l'été (EDT), 6 h l'hiver.
  perform cron.schedule('cc-digest-daily', '0 11 * * *',
    $cmd$ select public.cc_call_function('cc-digest', '{"mode":"daily"}'::jsonb); $cmd$);

  -- Dimanche 13:00 UTC = 9 h à Montréal : le dossier est prêt bien avant
  -- la réunion de l'après-midi.
  perform cron.schedule('cc-digest-weekly', '0 13 * * 0',
    $cmd$ select public.cc_call_function('cc-digest', '{"mode":"weekly"}'::jsonb); $cmd$);

  raise notice 'Command Center : 4 tâches planifiées créées.';
end $$;
