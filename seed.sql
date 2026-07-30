-- ============================================================
-- Données d'un seul immeuble réel — à exécuter APRÈS schema.sql
-- ============================================================
-- ÉTAPE MANUELLE REQUISE AVANT D'EXÉCUTER CE FICHIER :
-- 1. Dans Supabase > Authentication > Users, crée manuellement
--    un utilisateur (email + mot de passe) pour ton premier
--    propriétaire réel.
-- 2. Copie son UUID (colonne "id" dans la table auth.users).
-- 3. Remplace 'REMPLACER_PAR_UUID_AUTH' ci-dessous par cet UUID.
-- Le trigger du schema.sql aura déjà créé sa ligne dans "users".
-- ============================================================

-- ============ PROPRIÉTAIRE ============
insert into owners (id, user_id, full_name, phone, spending_cap, management_rate)
values (
  '11111111-1111-1111-1111-111111111111',
  'REMPLACER_PAR_UUID_AUTH',
  'Denis Marceau',
  '514-555-0100',
  300,
  6.00
);

-- ============ IMMEUBLE ============
insert into buildings (id, owner_id, address, unit_count, year_built)
values (
  '22222222-2222-2222-2222-222222222222',
  '11111111-1111-1111-1111-111111111111',
  '1220 rue des Érables',
  4,
  1987
);

-- ============ 4 LOGEMENTS ============
insert into units (id, building_id, unit_number, unit_type, rent, status) values
('33333333-3333-3333-3333-333333333331', '22222222-2222-2222-2222-222222222222', '1', '3½', 1420, 'occupied'),
('33333333-3333-3333-3333-333333333332', '22222222-2222-2222-2222-222222222222', '2', '4½', 1450, 'occupied'),
('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', '3', '3½', 1380, 'occupied'),
('33333333-3333-3333-3333-333333333334', '22222222-2222-2222-2222-222222222222', '4', '4½', 1450, 'available');

-- ============ 3 LOCATAIRES ============
insert into tenants (id, full_name, email, phone) values
('44444444-4444-4444-4444-444444444441', 'Marie Tremblay', 'marie.tremblay@example.com', '514-555-0111'),
('44444444-4444-4444-4444-444444444442', 'Karim Benali', 'karim.benali@example.com', '514-555-0112'),
('44444444-4444-4444-4444-444444444443', 'Sophie Larue', 'sophie.larue@example.com', '514-555-0113');

-- ============ 3 BAUX ============
insert into leases (id, unit_id, tenant_id, start_date, end_date, monthly_rent, status) values
('55555555-5555-5555-5555-555555555551', '33333333-3333-3333-3333-333333333331', '44444444-4444-4444-4444-444444444441', '2025-07-01', '2027-06-30', 1420, 'renewed'),
('55555555-5555-5555-5555-555555555552', '33333333-3333-3333-3333-333333333332', '44444444-4444-4444-4444-444444444442', '2025-07-01', '2027-06-30', 1450, 'active'),
('55555555-5555-5555-5555-555555555553', '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444443', '2025-10-01', '2026-09-30', 1380, 'active');

-- ============ 4 PAIEMENTS ============
insert into payments (lease_id, amount, due_date, paid_date, status) values
('55555555-5555-5555-5555-555555555551', 1420, '2026-06-01', '2026-06-01', 'paid'),
('55555555-5555-5555-5555-555555555551', 1420, '2026-07-01', '2026-07-01', 'paid'),
('55555555-5555-5555-5555-555555555552', 1450, '2026-07-01', '2026-07-01', 'paid'),
('55555555-5555-5555-5555-555555555553', 1380, '2026-07-01', null, 'late');

-- ============ 1 TRAVAILLEUR (pour l'exemple) ============
insert into workers (id, name, specialty, rbq_license, phone) values
('66666666-6666-6666-6666-666666666661', 'S. Cormier', 'CVC', 'RBQ-4821', '514-555-0356');

-- ============ 1 DÉPENSE (réalisée, déjà payée) ============
insert into expenses (building_id, unit_id, description, amount, expense_date) values
('22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333331', 'Peinture — unité 1', 420, '2026-07-12');

-- ============ 1 DEMANDE DE RÉPARATION ============
insert into service_requests (id, unit_id, tenant_id, description, status) values
('77777777-7777-7777-7777-777777777771', '33333333-3333-3333-3333-333333333332', '44444444-4444-4444-4444-444444444442', 'Le chauffe-eau ne chauffe plus.', 'open');

-- ============ WORK ORDER (dépasse le plafond de 300$) ============
insert into work_orders (id, service_request_id, unit_id, worker_id, description, estimated_cost, status) values
('88888888-8888-8888-8888-888888888881', '77777777-7777-7777-7777-777777777771', '33333333-3333-3333-3333-333333333332', '66666666-6666-6666-6666-666666666661', 'Remplacement chauffe-eau', 640, 'open');

-- ============ 1 APPROBATION (en attente — dépasse le plafond) ============
insert into approvals (work_order_id, owner_id, requested_amount, spending_cap_at_request, status) values
('88888888-8888-8888-8888-888888888881', '11111111-1111-1111-1111-111111111111', 640, 300, 'pending');
