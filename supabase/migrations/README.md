# Migrations SQL — nouvelle convention

`schema.sql` (à la racine du repo) reste l'historique figé de tout ce qui a déjà été appliqué manuellement à la base de production. On n'y ajoute plus rien.

**À partir de maintenant, toute nouvelle modification de schéma va ici, un fichier par changement.**

## Comment ajouter une migration

1. Nomme le fichier `YYYYMMDDHHMMSS_description-courte.sql` (ex: `20260817220000_ajoute_module_comptable.sql`). Si tu as la CLI Supabase installée en local : `supabase migration new description-courte` le fait automatiquement avec le bon horodatage.
2. Écris le SQL — pas besoin de garde `if not exists` ici puisque chaque fichier n'est censé s'exécuter qu'une seule fois (contrairement à `schema.sql`).
3. Colle-le manuellement dans Supabase Dashboard → SQL Editor pour l'appliquer à la production (tant que le déploiement automatique des migrations n'est pas branché — voir README.md racine, section CI/CD).
4. Commit et push le fichier de migration — même s'il n'est pas encore appliqué automatiquement, il doit rester dans l'historique du repo comme trace de ce qui a été fait.
