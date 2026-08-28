-- Dossiers surveilles, designes un par un.
--
-- La convention « un sous-dossier par entreprise » suppose que l'utilisateur
-- range les fichiers. Or la source la plus interessante est le dossier
-- d'export de la caisse elle-meme — souvent un partage reseau sur le serveur
-- de back-office — dont l'organisation ne nous appartient pas.
--
-- Une entree dit: « tout ce qui arrive dans ce dossier appartient a cette
-- entreprise ». Le logiciel de caisse ecrit ou il veut; c'est a nous de nous
-- adapter.

CREATE TABLE IF NOT EXISTS business_folder_sources (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL,
    -- Chemin local ou UNC (\\SERVEUR\Partage\Rapports).
    path        TEXT NOT NULL,
    -- Motif de nom de fichier, optionnel: « ventes*.csv ».
    pattern     TEXT NOT NULL DEFAULT '',
    label       TEXT NOT NULL DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    last_run_at TEXT NOT NULL DEFAULT '',
    last_error  TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (org_id) REFERENCES organizations (id)
);

CREATE INDEX IF NOT EXISTS idx_folder_sources_org ON business_folder_sources (org_id);
