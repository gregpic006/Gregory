-- Section Articles/Blogue du site public — demande directe de
-- l'utilisateur. Modèle simple et cohérent avec le reste du projet :
-- corps en texte brut (rendu en paragraphes côté client, comme
-- marketplace_description ailleurs), pas d'éditeur riche — cohérent
-- avec l'absence de framework/bundler du reste du site.
create table blog_posts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text not null unique,
  excerpt text,
  body text not null,
  cover_photo_path text,
  author_name text default 'L''équipe Portail',
  status text default 'draft' check (status in ('draft', 'published')),
  published_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table blog_posts enable row level security;

create policy "admin manages blog posts" on blog_posts for all
  using (auth_is_admin()) with check (auth_is_admin());
create policy "public reads published blog posts" on blog_posts for select
  using (status = 'published');

create index idx_blog_posts_published on blog_posts(published_at desc) where status = 'published';

-- Bucket public (même posture que listing-photos) : images d'articles
-- destinées à être vues par n'importe quel visiteur. Écriture
-- admin-only par RLS, lecture publique via l'URL directe du bucket.
insert into storage.buckets (id, name, public)
values ('blog-photos', 'blog-photos', true)
on conflict (id) do nothing;

create policy "admin upload blog photos" on storage.objects for insert
  with check (bucket_id = 'blog-photos' and auth_is_admin());
create policy "admin manage blog photos" on storage.objects for select
  using (bucket_id = 'blog-photos' and auth_is_admin());
create policy "admin delete blog photos" on storage.objects for delete
  using (bucket_id = 'blog-photos' and auth_is_admin());
