# Sauvegardes et restauration

## Ce qui est en place

`.github/workflows/backup.yml` — une sauvegarde complète de la base (`pg_dump`, format custom) tous les jours à 8h UTC, plus déclenchable manuellement (onglet **Actions** du repo → "Sauvegarde de la base de données" → "Run workflow"). Le fichier est conservé 30 jours comme artefact GitHub Actions, puis supprimé automatiquement.

**Ceci est un filet de sécurité, pas un remplacement des sauvegardes Supabase natives.** Vérifie ton forfait :
- **Free** : aucune sauvegarde automatique côté Supabase — ce workflow GitHub Actions est ta *seule* protection. À prendre au sérieux.
- **Pro (25 $/mois)** : sauvegardes quotidiennes automatiques incluses, conservées 7 jours.
- **Pro + add-on PITR** : récupération à un point dans le temps (n'importe quelle minute des 7-28 derniers jours selon l'option) — la vraie protection pour un service en production avec de l'argent réel qui transite (loyers, PAD).

Recommandation à mesure que le nombre de portes augmente (voir 🟠/🟡 de la roadmap) : passer sur Pro + PITR n'est plus optionnel une fois qu'il y a des vrais clients payants — un dump quotidien perd jusqu'à 24h de données en cas de problème.

## Configuration requise (une seule fois)

1. Dans Supabase Dashboard → **Project Settings → Database → Connection string**, copie la chaîne au format **URI**, mode **Session pooler** (recommandé pour les scripts ponctuels comme celui-ci — pas le mode Transaction).
2. Dans GitHub → ce repo → **Settings → Secrets and variables → Actions → New repository secret** :
   - Nom : `SUPABASE_DB_URL`
   - Valeur : la chaîne complète copiée à l'étape 1 (avec le mot de passe dedans)

## Comment restaurer

**⚠️ Une restauration écrase les données existantes — à ne faire que sur une base vide (ex: le projet de préproduction) ou en cas de sinistre réel sur la prod, jamais "pour essayer".**

1. Va dans l'onglet **Actions** du repo → "Sauvegarde de la base de données" → choisis une exécution → télécharge l'artefact `portail-backup-<id>` (fichier `portail-backup.dump`).
2. Restaure avec `pg_restore` (inclus avec PostgreSQL, ou `postgresql-client` sur Linux) :
   ```
   pg_restore --no-owner --no-privileges --clean --if-exists \
     -d "<connection-string-de-destination>" \
     portail-backup.dump
   ```
3. Vérifie manuellement quelques tables clés (`owners`, `leases`, `payments`) avant de considérer la restauration terminée.

## Sauvegarde manuelle ponctuelle (sans attendre le cron)

Depuis un poste avec `pg_dump` installé et la chaîne de connexion :
```
pg_dump "<connection-string>" --no-owner --no-privileges --format=custom --file=backup-manuel.dump
```
