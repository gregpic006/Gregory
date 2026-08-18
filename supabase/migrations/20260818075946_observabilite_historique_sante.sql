-- ============================================================
-- OBSERVABILITÉ — historique des vérifications de santé
-- ============================================================
-- check_system_health() (voir schema.sql) donnait déjà un instantané
-- "en ce moment", mais rien n'était conservé — impossible de savoir si
-- un incident était ponctuel ou récurrent, ou de voir une tendance se
-- dégrader avant qu'elle devienne une alerte. Cette table capture
-- chaque exécution du cron de 15 minutes (déjà en place), healthy ou
-- non, pour donner une vraie ligne du temps.
create table if not exists system_health_log (
  id uuid primary key default gen_random_uuid(),
  checked_at timestamptz default now(),
  healthy boolean not null,
  issue_count int not null default 0,
  issues jsonb not null default '[]'::jsonb
);

create index if not exists idx_system_health_log_checked_at on system_health_log (checked_at desc);

alter table system_health_log enable row level security;
create policy "admin reads system health log" on system_health_log for select
  using (auth_is_admin());

-- Redéfinit trigger_health_check_alert() pour consigner CHAQUE
-- exécution dans system_health_log (pas seulement quand ça déclenche une
-- alerte) — le comportement d'alerte (throttle 2h, envoi du courriel)
-- reste identique, seul l'ajout de l'insertion d'historique change.
create or replace function trigger_health_check_alert()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_health jsonb;
  v_last_alert timestamptz;
  v_health_key text;
begin
  v_health := check_system_health();

  insert into system_health_log (healthy, issue_count, issues)
  values (
    (v_health->>'healthy')::boolean,
    jsonb_array_length(v_health->'issues'),
    v_health->'issues'
  );

  if (v_health->>'healthy')::boolean then
    return;
  end if;

  select last_alert_sent_at into v_last_alert from system_health_alert_state where id = true;
  if v_last_alert is not null and v_last_alert > now() - interval '2 hours' then
    return; -- déjà alerté récemment pour cet incident en cours
  end if;

  select decrypted_secret into v_health_key from vault.decrypted_secrets where name = 'health_alert_secret';

  perform net.http_post(
    url := 'https://kdmwfbcziokygfcmjxeq.supabase.co/functions/v1/send-health-alert',
    body := jsonb_build_object('issues', v_health->'issues'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR',
      'apikey', 'sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR',
      'x-health-alert-key', coalesce(v_health_key, '')
    )
  );

  update system_health_alert_state set last_alert_sent_at = now() where id = true;
end;
$$;

-- Purge les entrées de plus de 30 jours pour ne pas accumuler
-- indéfiniment (à 96 lignes/jour — cron aux 15 minutes — ça reste petit,
-- mais autant garder l'habitude dès le départ).
create or replace function purge_old_health_log()
returns void
language sql
security definer
set search_path = public
as $$
  delete from system_health_log where checked_at < now() - interval '30 days';
$$;

select cron.schedule('purge-old-health-log', '0 4 * * *', $$select purge_old_health_log()$$);
