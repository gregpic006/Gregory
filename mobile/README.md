# Portail — app mobile (iOS / Android)

Coquille native [Capacitor](https://capacitorjs.com) autour des portails web existants. **Aucune logique métier ici** : l'app charge en direct `https://portailgestion.ca/app.html`, exactement comme un navigateur — la connexion, les 3 portails (propriétaire/locataire/travailleur) et tout le reste continuent de tourner sur le même code et le même backend Supabase que le site web. Publier une mise à jour de `portail-locataire.html` etc. met à jour l'app instantanément, sans nouvelle soumission aux stores.

`app.html` (à la racine du repo) est le point d'entrée : connexion unique, puis redirection automatique vers le bon portail selon le rôle du compte (fonction `whoami`).

## Ce qui est déjà fait

- `app.html` — écran de connexion unifié + redirection par rôle
- `edge-function-whoami.ts` — déterminé le rôle (propriétaire/locataire/travailleur) côté serveur après connexion
- Ce dossier (`package.json`, `capacitor.config.json`, `www/`) — squelette du projet Capacitor

## Ce qu'il reste à faire (nécessite un Mac + Xcode pour iOS)

Rien de tout ça ne peut se faire depuis un environnement cloud — Apple exige Xcode sur macOS pour compiler une app iOS, il n'y a pas de contournement.

1. **Comptes développeur** (à créer par vous, pas par moi) :
   - Apple Developer Program — 99 $ US/an — [developer.apple.com](https://developer.apple.com)
   - Google Play Console — 25 $ US une fois — [play.google.com/console](https://play.google.com/console)

2. **Installer les outils** :
   - iOS : Xcode (Mac App Store, gratuit)
   - Android : [Android Studio](https://developer.android.com/studio) (gratuit, toutes plateformes)

3. **Générer les projets natifs** (depuis ce dossier `mobile/`) :
   ```
   npm install
   npx cap add ios
   npx cap add android
   ```

4. **Ouvrir et lancer** :
   ```
   npx cap open ios       # ouvre Xcode
   npx cap open android   # ouvre Android Studio
   ```
   De là, bouton ▶️ pour tester sur simulateur/téléphone, puis suivre le flux normal de chaque plateforme pour soumettre aux stores (TestFlight pour iOS en bêta, Play Console pour Android).

5. **Icône et écran de démarrage** : Capacitor fournit un outil (`@capacitor/assets`) pour générer toutes les tailles d'icônes à partir d'une seule image — il faudra une icône carrée (1024×1024, fond opaque, pas de texte trop petit) avant cette étape.

## Pourquoi cette approche plutôt qu'une réécriture complète

Réécrire en Swift/Kotlin natif ou en React Native aurait dupliqué tout le travail déjà fait sur les 3 portails, avec un vrai risque de désynchronisation entre le web et le mobile. Cette approche garde une seule base de code — celle qui tourne déjà en production, testée toute la soirée.
