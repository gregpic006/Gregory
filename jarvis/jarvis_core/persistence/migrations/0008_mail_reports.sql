-- Regles d'import par courriel.
--
-- Beaucoup de caisses et de logiciels de gestion savent envoyer un rapport
-- par courriel a heure fixe. C'est la seule voie d'integration qui ne demande
-- ni entente avec un fournisseur, ni cle d'API, ni mot de passe: le rapport
-- arrive deja dans la boite de l'utilisateur, et JARVIS y a deja acces.
--
-- Une regle dit: « quand tel expediteur m'ecrit, importe la piece jointe dans
-- telle entreprise ».

CREATE TABLE IF NOT EXISTS business_mail_rules (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL,
    -- Fragment d'adresse: « rapports@macaisse.com », ou juste « macaisse ».
    sender      TEXT NOT NULL,
    -- Fragment d'objet, optionnel: distingue deux rapports du meme envoyeur.
    subject     TEXT NOT NULL DEFAULT '',
    label       TEXT NOT NULL DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    last_run_at TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (org_id) REFERENCES organizations (id)
);

CREATE INDEX IF NOT EXISTS idx_mail_rules_org ON business_mail_rules (org_id);

-- Un courriel deja importe ne doit jamais l'etre deux fois: la caisse envoie
-- le meme rapport tous les jours, et la surveillance repasse toutes les
-- heures. L'unicite est portee par la base, pas par une verification qu'on
-- pourrait oublier d'ecrire.
CREATE TABLE IF NOT EXISTS business_mail_seen (
    message_id  TEXT NOT NULL,
    -- Une meme piece jointe importee dans deux entreprises reste legitime.
    org_id      TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    PRIMARY KEY (message_id, org_id)
);
