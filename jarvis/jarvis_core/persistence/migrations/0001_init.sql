-- Schema initial de JARVIS (M1).
-- Concu pour migrer vers PostgreSQL sans reecriture: pas de type exotique,
-- identifiants texte, horodatages ISO-8601 en UTC.

CREATE TABLE IF NOT EXISTS organizations (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'company',
    created_at   TEXT NOT NULL
);

-- Memoire persistante: personnes, entreprises, preferences, decisions.
-- Chaque souvenir porte une source et un niveau de confiance: le modele ne
-- peut pas inventer un souvenir sans tracabilite.
CREATE TABLE IF NOT EXISTS memories (
    id           TEXT PRIMARY KEY,
    org_id       TEXT NOT NULL DEFAULT 'PERSONAL',
    kind         TEXT NOT NULL,            -- personal | business | event | preference
    subject      TEXT NOT NULL DEFAULT '', -- entite concernee (ex: "Xavier", "Portail")
    content      TEXT NOT NULL,
    source       TEXT NOT NULL,            -- utilisateur | courriel | document | deduction
    confidence   REAL NOT NULL DEFAULT 0.8,
    happened_at  TEXT,                     -- pour la memoire evenementielle
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    FOREIGN KEY (org_id) REFERENCES organizations(id)
);

CREATE INDEX IF NOT EXISTS idx_memories_org_kind ON memories (org_id, kind);
CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories (subject);

CREATE TABLE IF NOT EXISTS reminders (
    id           TEXT PRIMARY KEY,
    org_id       TEXT NOT NULL DEFAULT 'PERSONAL',
    text         TEXT NOT NULL,
    due_at       TEXT NOT NULL,            -- ISO-8601 avec fuseau
    due_label    TEXT NOT NULL DEFAULT '', -- expression d'origine ("demain matin")
    status       TEXT NOT NULL DEFAULT 'pending', -- pending | done | cancelled
    created_at   TEXT NOT NULL,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_reminders_status_due ON reminders (status, due_at);

-- Piste d'audit: chaque appel d'outil, sa permission et son issue.
CREATE TABLE IF NOT EXISTS audit_logs (
    id                TEXT PRIMARY KEY,
    timestamp         TEXT NOT NULL,
    session_id        TEXT NOT NULL,
    user_request      TEXT NOT NULL DEFAULT '',
    tool              TEXT NOT NULL,
    action            TEXT NOT NULL DEFAULT '',
    parameters        TEXT NOT NULL DEFAULT '{}',
    permission_level  INTEGER NOT NULL,
    decision          TEXT NOT NULL,
    confirmed         INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL,
    duration_ms       INTEGER NOT NULL DEFAULT 0,
    result_summary    TEXT NOT NULL DEFAULT '',
    error             TEXT NOT NULL DEFAULT '',
    injection_signals TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs (timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_logs (session_id);

INSERT OR IGNORE INTO organizations (id, name, kind, created_at)
VALUES ('PERSONAL', 'Personnel', 'personal', '1970-01-01T00:00:00+00:00');
