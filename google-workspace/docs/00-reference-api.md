# Vérité terrain — extraite des définitions de types de `googleapis@178.0.0`
Ces types sont générés automatiquement à partir des documents de découverte de Google.
Source faisant autorité. À utiliser pour corriger tout code écrit de mémoire.

## Version du paquet
`googleapis` : **178.0.0** (et NON ^144 — corriger package.json)

---
## DRIVE v3 — Drive partagé

### PIÈGE MAJEUR #1 — restrictions à la création
Commentaire officiel sur `Schema$Drive.restrictions` :
> "Note that restrictions can't be set when creating a shared drive.
>  To add a restriction, first create a shared drive and then use `drives.update`
>  to add restrictions."

=> `drives.create` NE DOIT PAS envoyer `restrictions`. Toujours :
   1. `drives.create({ requestId, requestBody: { name } })`
   2. PUIS `drives.update({ driveId, requestBody: { restrictions: {...} } })`

### Restrictions valides (noms EXACTS, tous booléens)
```
restrictions: {
  adminManagedRestrictions?: boolean
  copyRequiresWriterPermission?: boolean
  domainUsersOnly?: boolean
  downloadRestriction?: Schema$DownloadRestriction   // objet, pas booléen
  driveMembersOnly?: boolean
  sharingFoldersRequiresOrganizerPermission?: boolean
}
```
Les 4 utilisés par la config existent tous. `downloadRestriction` est un OBJET — ne pas
lui passer un booléen.

### drives.create — paramètres
```
{ requestId: string, requestBody: Schema$Drive }
```
`requestId` : doit être STABLE/déterministe (hash SHA-256 du nom du drive) pour qu'un
re-lancement après un timeout ne crée pas de doublon.

### drives.list — paramètres
```
{ pageSize?, pageToken?, q?, useDomainAdminAccess? }
```
PAS de `fields` obligatoire mais le demander explicitement. Pagination via `pageToken`.

### drives.update — paramètres
```
{ driveId, useDomainAdminAccess?, requestBody }
```

### permissions.create — paramètres
```
{ fileId, supportsAllDrives, useDomainAdminAccess?, sendNotificationEmail?,
  emailMessage?, transferOwnership?, moveToNewOwnersRoot?,
  enforceExpansiveAccess?, enforceSingleParent?, supportsTeamDrives? (déprécié),
  requestBody: Schema$Permission }
```
Pour un Drive partagé : `fileId` = `driveId`, `supportsAllDrives: true` OBLIGATOIRE.

### Schema$Permission — valeurs EXACTES
- `role` : `owner` | `organizer` | `fileOrganizer` | `writer` | `commenter` | `reader`
- `type` : `user` | `group` | `domain` | `anyone`
  > "if `type` is `user` or `group`, you must provide an `emailAddress`"
  => `type:'group'` FONCTIONNE pour ajouter un groupe Google. Confirmé.
- `domain`, `emailAddress`, `id`, `deleted`, `displayName` sont **Output only**
  (sauf emailAddress/domain qu'on fournit à la création).

---
## CALENDAR v3

### Schema$AclRule — valeurs EXACTES
```
{ role: string, scope: { type: string, value: string } }
```
- `role` : `none` | `freeBusyReader` | `reader` | `writerWithoutPrivateAccess` | `writer` | `owner`
  ATTENTION : `writerWithoutPrivateAccess` existe (souvent oublié).
  `owner` = accès gestionnaire (peut modifier les ACL des autres), ≠ propriétaire des données.
- `scope.type` : `default` | `user` | `group` | `domain`
  => `type:'group'` est valide pour un groupe Workspace.

### Schema$CalendarListEntry — champs pour l'affichage automatique
`id`, `selected`, `hidden`, `colorId`, `summaryOverride`, `accessRole`, `primary`, `timeZone`
=> `calendarList.insert({ requestBody: { id: <calendarId>, selected: true } })` en
   impersonnant chaque usager fait apparaître le calendrier sans clic. C'est le mécanisme
   du « zéro manipulation ». Ne fonctionne QU'EN mode compte de service + délégation.

---
## ADMIN SDK DIRECTORY v1

### Schema$User — champs confirmés
```
primaryEmail, recoveryEmail, recoveryPhone, emails (type `any` !), aliases[],
nonEditableAliases[], isAdmin, isDelegatedAdmin, suspended, archived,
isEnrolledIn2Sv, isEnforcedIn2Sv, lastLoginTime, creationTime, name, customerId, orgUnitPath
```
PIÈGE #2 : `emails` est typé `any` dans le .d.ts — c'est un TABLEAU de `Schema$UserEmail`.
Le code doit être défensif : `Array.isArray(user.emails) ? user.emails : []`.

### Schema$UserEmail — forme d'une entrée de emails[]
```
{ address, customType, primary, type, public_key_encryption_certificates }
```
PIÈGE #3 : `emails[]` se remplace EN ENTIER lors d'un update. Pour retirer une adresse
secondaire, il faut relire le tableau, filtrer, et réécrire l'ensemble en préservant
l'entrée `primary: true`.

### Schema$Member
```
{ email, role, type, status, deliverySettings }
```
`role` : OWNER | MANAGER | MEMBER

---
## GROUPS SETTINGS v1 — valeurs EXACTES (chaînes, pas booléens !)

PIÈGE #4 : `allowExternalMembers` est de type **string** (`"true"`/`"false"`), PAS booléen.
Tous les champs de Schema$Groups sont des `string`.

- `whoCanJoin` : `ANYONE_CAN_JOIN` | `ALL_IN_DOMAIN_CAN_JOIN` | `INVITED_CAN_JOIN` | `CAN_REQUEST_TO_JOIN`
  => pour un groupe d'équipe fermé : `INVITED_CAN_JOIN`
- `whoCanViewMembership` : `ALL_IN_DOMAIN_CAN_VIEW` | `ALL_MEMBERS_CAN_VIEW` | `ALL_MANAGERS_CAN_VIEW`
  => `ALL_MEMBERS_CAN_VIEW`
- `whoCanPostMessage` : `NONE_CAN_POST` | `ALL_MANAGERS_CAN_POST` | `ALL_MEMBERS_CAN_POST`
                      | `ALL_OWNERS_CAN_POST` | `ALL_IN_DOMAIN_CAN_POST` | `ANYONE_CAN_POST`
  => `ALL_MEMBERS_CAN_POST`
  ATTENTION : mettre `NONE_CAN_POST` alors que `archiveOnly` est false => ERREUR.
- `whoCanDiscoverGroup` : `ANYONE_CAN_DISCOVER` | `ALL_IN_DOMAIN_CAN_DISCOVER` | `ALL_MEMBERS_CAN_DISCOVER`
  => `ALL_IN_DOMAIN_CAN_DISCOVER`
- `allowExternalMembers` : `"false"` (chaîne)
- Autres champs disponibles : `whoCanViewGroup`, `whoCanLeaveGroup`, `whoCanModerateMembers`,
  `isArchived`, `membersCanPostAsTheGroup`

---
## CONFIG DU DÉPLOIEMENT
> ⚠️ Ce dépôt est PUBLIC. Aucune adresse personnelle ni adresse d'employé ne doit
> apparaître ici. Les vraies valeurs vivent dans `config.json`, qui est gitignoré et
> généré localement par `node src/cli.mjs init`.
- Domaine Workspace : découvert par `init` (jamais écrit en dur ici — dépôt public)
- Super-admin : le compte super-admin du domaine (rempli par `init`)
- Adresse perso à détacher : <adresse-perso@gmail.com>  # jamais commitée — voir config.json (gitignoré)
- Groupe d'équipe : `equipe@<domaine>` par défaut, modifiable dans config.json
- Mode d'auth choisi : **service-account** (compte de service + délégation)
- Adresses de l'équipe : découvertes automatiquement
  => la commande `init` doit les DÉCOUVRIR via `admin.users.list` plutôt que de les
     demander au client. C'est ça, « le moins de manipulation possible ».

---
## SCOPES OAuth — vérifiés dans les discovery documents
(admin/directory_v1 rev 20260823, calendar/v3 rev 20260826, drive/v3 rev 20260824,
 groupssettings/v1 rev 20220614)

### Jeu MINIMAL exact pour la trousse
```
https://www.googleapis.com/auth/admin.directory.user
https://www.googleapis.com/auth/admin.directory.group
https://www.googleapis.com/auth/admin.directory.group.member
https://www.googleapis.com/auth/admin.directory.customer.readonly
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/drive
https://www.googleapis.com/auth/apps.groups.settings
```

### Ligne prête à coller dans la console d'admin (délégation)
```
https://www.googleapis.com/auth/admin.directory.user,https://www.googleapis.com/auth/admin.directory.group,https://www.googleapis.com/auth/admin.directory.group.member,https://www.googleapis.com/auth/admin.directory.customer.readonly,https://www.googleapis.com/auth/calendar,https://www.googleapis.com/auth/drive,https://www.googleapis.com/auth/apps.groups.settings
```

### Notes
- `calendar` (complet) couvre calendars + acls + calendarlist. Inutile de lister
  `calendar.acls` / `calendar.calendars` / `calendar.calendarlist` séparément.
- `drive` (complet) est REQUIS : `drive.file` ne suffit pas (il ne voit que les fichiers
  créés par l'app, donc impossible de gérer un Drive partagé existant ou de faire l'audit).
- `admin.directory.customer.readonly` suffit pour `customers.get` (l'audit). Passer à
  `admin.directory.customer` (écriture) UNIQUEMENT si on veut modifier `alternateEmail`.
- PIÈGE #5 : la liste de scopes collée dans la console de délégation doit correspondre
  EXACTEMENT (au caractère près) à celle demandée par le code. Un scope demandé mais
  absent de la console => `unauthorized_client`. C'est LA cause n°1 d'échec.

---
## AJOUTS DEMANDÉS APRÈS COUP (à intégrer en passe de correction)
1. `package.json` : `googleapis` doit être `^178.0.0`, pas `^144.0.0`.
2. Nouvelle commande **`init`** : découvre les usagers réels du domaine via
   `admin.users.list` et GÉNÈRE `config.json` automatiquement. Le client n'a jamais eu
   à taper les 3 autres adresses de son équipe. C'est le cœur du « moins de
   manipulation possible ».
3. Nouvelle commande **`dns`** : vérifie MX / SPF / DKIM / DMARC du domaine
   (via `node:dns/promises`, aucune dépendance). Signale si les courriels ne sont pas
   routés vers Google. À faire tourner chez le client — le proxy de la session de build
   bloquait le DNS sortant.
4. Aucune valeur réelle en dur : `init` découvre le domaine, les usagers et
   l'adresse personnelle à détacher. Le dépôt est public.
