-- Organisations declarees (M2+).
--
-- Elles structurent le centre de commande business. Aucune donnee metier n'est
-- inventee: tant qu'une source n'est pas branchee, chaque indicateur est
-- explicitement marque « non connecte ».

INSERT OR IGNORE INTO organizations (id, name, kind, created_at) VALUES
    ('RESTAURANT_GA',      'Grande Allee', 'restaurant', '1970-01-01T00:00:00+00:00'),
    ('RESTAURANT_MAGUIRE', 'Maguire',      'restaurant', '1970-01-01T00:00:00+00:00'),
    ('RESTAURANT_BOUVIER', 'Bouvier',      'restaurant', '1970-01-01T00:00:00+00:00'),
    ('PORTAIL',            'Portail',      'saas',       '1970-01-01T00:00:00+00:00'),
    ('REAL_ESTATE',        'Immobilier',   'realestate', '1970-01-01T00:00:00+00:00');
