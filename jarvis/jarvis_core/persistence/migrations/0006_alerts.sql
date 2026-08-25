-- Alertes proactives (M5).
--
-- `dedup_key` est la garantie anti-harcelement: la meme reunion, le meme
-- rappel, la meme donnee perimee ne peuvent produire qu'une alerte, meme si la
-- surveillance tourne toutes les cinq minutes.

CREATE TABLE IF NOT EXISTS alerts (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,           -- calendar | email | reminder | business
    severity    TEXT NOT NULL DEFAULT 'info',
    title       TEXT NOT NULL,
    detail      TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL,           -- systeme d'ou vient l'information
    dedup_key   TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    seen_at     TEXT NOT NULL DEFAULT '',
    expires_at  TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_dedup ON alerts (dedup_key);
CREATE INDEX IF NOT EXISTS idx_alerts_recent ON alerts (created_at DESC);

-- Briefings generes, conserves pour pouvoir relire celui du matin.
CREATE TABLE IF NOT EXISTS briefings (
    id         TEXT PRIMARY KEY,
    day        TEXT NOT NULL,
    text       TEXT NOT NULL,
    sources    TEXT NOT NULL DEFAULT '',  -- JSON: sources reellement consultees
    created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_briefings_day ON briefings (day);
