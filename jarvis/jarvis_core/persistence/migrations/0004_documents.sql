-- Documents et recherche (M3).
--
-- L'index lexical FTS5 est cree systematiquement: il ne demande aucun
-- telechargement et fonctionne hors ligne. Les vecteurs sont optionnels
-- (colonne nullable) — sans eux, la recherche reste lexicale et le dit.

CREATE TABLE IF NOT EXISTS documents (
    id           TEXT PRIMARY KEY,
    org_id       TEXT NOT NULL DEFAULT 'PERSONAL',
    title        TEXT NOT NULL,
    source       TEXT NOT NULL,          -- 'local' | 'drive'
    path         TEXT NOT NULL DEFAULT '',
    external_id  TEXT NOT NULL DEFAULT '',
    url          TEXT NOT NULL DEFAULT '',
    mime         TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL,          -- reingestion idempotente
    bytes        INTEGER NOT NULL DEFAULT 0,
    chunk_count  INTEGER NOT NULL DEFAULT 0,
    modified_at  TEXT NOT NULL DEFAULT '',
    indexed_at   TEXT NOT NULL,
    FOREIGN KEY (org_id) REFERENCES organizations (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_identity
    ON documents (source, path, external_id);
CREATE INDEX IF NOT EXISTS idx_documents_org ON documents (org_id);

CREATE TABLE IF NOT EXISTS document_chunks (
    id          TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    position    INTEGER NOT NULL,
    locator     TEXT NOT NULL DEFAULT '',
    text        TEXT NOT NULL,
    embedding   BLOB,                    -- NULL = pas de vecteur pour ce morceau
    FOREIGN KEY (document_id) REFERENCES documents (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunks_document ON document_chunks (document_id);

-- Index lexical. `remove_diacritics 2` fait que « reservation » trouve
-- « réservation »: indispensable quand on dicte a la voix.
CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5 (
    text,
    content = 'document_chunks',
    content_rowid = 'rowid',
    tokenize = "unicode61 remove_diacritics 2"
);

CREATE TRIGGER IF NOT EXISTS document_chunks_ai AFTER INSERT ON document_chunks BEGIN
    INSERT INTO document_chunks_fts (rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER IF NOT EXISTS document_chunks_ad AFTER DELETE ON document_chunks BEGIN
    INSERT INTO document_chunks_fts (document_chunks_fts, rowid, text)
    VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER IF NOT EXISTS document_chunks_au AFTER UPDATE ON document_chunks BEGIN
    INSERT INTO document_chunks_fts (document_chunks_fts, rowid, text)
    VALUES ('delete', old.rowid, old.text);
    INSERT INTO document_chunks_fts (rowid, text) VALUES (new.rowid, new.text);
END;
