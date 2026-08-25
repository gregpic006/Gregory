-- Donnees business (M4).
--
-- Un fait = un indicateur, une organisation, un jour, une source. Cette forme
-- est volontairement plate: elle rend impossible de stocker un chiffre sans
-- dire d'ou il vient ni de quand il date.
--
-- La contrainte d'unicite rend le reimport idempotent: reimporter le meme
-- fichier corrige les valeurs au lieu de les additionner en double.

CREATE TABLE IF NOT EXISTS business_facts (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL,
    metric      TEXT NOT NULL,           -- cf. jarvis_core/business/metrics.py
    day         TEXT NOT NULL,           -- AAAA-MM-JJ, jour d'affaires
    value       REAL NOT NULL,
    unit        TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL,           -- 'csv' | 'stripe' | 'manuel'
    source_ref  TEXT NOT NULL DEFAULT '', -- nom du fichier, identifiant distant
    recorded_at TEXT NOT NULL,
    FOREIGN KEY (org_id) REFERENCES organizations (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_identity
    ON business_facts (org_id, metric, day, source);
CREATE INDEX IF NOT EXISTS idx_facts_lookup ON business_facts (org_id, metric, day DESC);

-- Journal des imports: ce qui a ete charge, quand, et ce qui a echoue.
CREATE TABLE IF NOT EXISTS business_imports (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL,
    source      TEXT NOT NULL,
    source_ref  TEXT NOT NULL DEFAULT '',
    rows_ok     INTEGER NOT NULL DEFAULT 0,
    rows_failed INTEGER NOT NULL DEFAULT 0,
    detail      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    FOREIGN KEY (org_id) REFERENCES organizations (id)
);

CREATE INDEX IF NOT EXISTS idx_imports_org ON business_imports (org_id, created_at DESC);
