-- Loi 25 (écart "élevé") : le formulaire public exige déjà une case à
-- cocher de consentement (handle-public-inquiry.ts refuse la requête
-- si elle est absente), mais ce consentement n'était jamais persisté —
-- aucune preuve horodatée n'existait après coup. consent_purpose fixe
-- la finalité exacte couverte (déjà scopée à cette seule demande, pas
-- un consentement générique à du marketing futur).
alter table inquiries add column if not exists consented_at timestamptz;
alter table inquiries add column if not exists consent_purpose text;
