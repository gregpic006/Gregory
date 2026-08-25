-- Les organisations appartiennent a l'utilisateur, pas au code (M4+).
--
-- La migration 0003 declarait cinq entreprises en dur, d'apres une premiere
-- conversation. C'etait une erreur de conception: JARVIS n'a pas a decider
-- quelles entreprises sont les siennes. Bouvier n'en fait pas partie.
--
-- On retire donc l'entree fautive, et on ajoute de quoi gerer la liste depuis
-- l'interface.

DELETE FROM business_facts WHERE org_id = 'RESTAURANT_BOUVIER';
DELETE FROM business_imports WHERE org_id = 'RESTAURANT_BOUVIER';
DELETE FROM memories WHERE org_id = 'RESTAURANT_BOUVIER';
DELETE FROM reminders WHERE org_id = 'RESTAURANT_BOUVIER';
DELETE FROM organizations WHERE id = 'RESTAURANT_BOUVIER';

-- Ordre d'affichage choisi par l'utilisateur, et archivage plutot que
-- suppression: on ne detruit pas des annees de chiffres sur un clic.
ALTER TABLE organizations ADD COLUMN position INTEGER NOT NULL DEFAULT 100;
ALTER TABLE organizations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

UPDATE organizations SET position = 10 WHERE id = 'RESTAURANT_GA';
UPDATE organizations SET position = 20 WHERE id = 'RESTAURANT_MAGUIRE';
UPDATE organizations SET position = 30 WHERE id = 'PORTAIL';
UPDATE organizations SET position = 40 WHERE id = 'REAL_ESTATE';
