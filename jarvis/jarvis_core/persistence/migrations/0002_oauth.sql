-- Jetons OAuth des integrations externes (M2).
--
-- Les jetons sont chiffres au repos (Fernet) AVANT insertion: cette table ne
-- contient jamais de secret en clair. Le mot de passe du compte n'est ni
-- demande ni stocke - c'est tout l'interet d'OAuth.

CREATE TABLE IF NOT EXISTS oauth_tokens (
    id             TEXT PRIMARY KEY,
    provider       TEXT NOT NULL,             -- google | (futurs fournisseurs)
    account        TEXT NOT NULL DEFAULT '',  -- adresse du compte connecte
    access_token   TEXT NOT NULL,             -- chiffre
    refresh_token  TEXT NOT NULL DEFAULT '',  -- chiffre
    token_type     TEXT NOT NULL DEFAULT 'Bearer',
    scopes         TEXT NOT NULL DEFAULT '',  -- separes par des espaces
    expires_at     TEXT NOT NULL,             -- ISO-8601 UTC
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    UNIQUE (provider, account)
);

CREATE INDEX IF NOT EXISTS idx_oauth_provider ON oauth_tokens (provider);
