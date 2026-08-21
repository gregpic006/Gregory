-- Photos des logements disponibles — trouvé lors d'un audit visuel du
-- site public : chaque logement affiché sur l'accueil montrait "Photo
-- à venir" (index.html loadLogements()), pas faute de données mais
-- parce que la colonne n'existait tout simplement pas. Un logement à
-- louer sans photo génère très peu de demandes sérieuses en pratique.
--
-- Bucket public (contrairement à documents/service-request-photos) :
-- ce sont des photos marketing destinées à être vues par n'importe
-- quel visiteur du site, pas des documents privés. Seul l'admin peut
-- écrire — l'accès public en lecture passe par l'URL publique du
-- bucket (qui contourne RLS par conception pour un bucket public),
-- jamais par l'API list/get authentifiée.
alter table units add column if not exists photo_urls jsonb default '[]'::jsonb;

insert into storage.buckets (id, name, public)
values ('listing-photos', 'listing-photos', true)
on conflict (id) do nothing;

create policy "admin upload listing photos" on storage.objects for insert
  with check (bucket_id = 'listing-photos' and auth_is_admin());
create policy "admin manage listing photos" on storage.objects for select
  using (bucket_id = 'listing-photos' and auth_is_admin());
create policy "admin delete listing photos" on storage.objects for delete
  using (bucket_id = 'listing-photos' and auth_is_admin());
