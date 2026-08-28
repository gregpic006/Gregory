# Architecture de JARVIS

Ce document explique **ce qui a ete choisi et pourquoi**. Il evolue avec le
projet ; chaque jalon y ajoute sa section.

---

## 1. Principes directeurs

Cinq regles ont tranche la plupart des arbitrages techniques.

1. **Fiabilite avant puissance.** Un assistant qui repond parfois faux est pire
   qu'un assistant limite mais honnete. Toute information non obtenue par un
   outil ou par la memoire n'existe pas.
2. **Le contenu externe n'est jamais une instruction.** Un courriel, un PDF ou
   une page web sont des donnees. Cette frontiere est materialisee dans le code,
   pas seulement dans le prompt.
3. **Le risque est explicite.** Chaque action porte un palier de permission ; les
   paliers dangereux ne peuvent pas etre auto-approuves.
4. **Extensible sans toucher au cerveau.** Ajouter une capacite = declarer un
   outil. L'orchestrateur ne change pas.
5. **Pas de complexite prematuree.** Monolithe modulaire, SQLite, un processus.
   Les frontieres sont posees pour pouvoir decouper plus tard, pas maintenant.

---

## 2. Choix technologiques

| Decision | Retenu | Alternatives ecartees | Raison |
|---|---|---|---|
| Langage backend | Python 3.11 | Node.js, Go | Ecosysteme IA/audio (Whisper, embeddings, parseurs de documents) sans equivalent ; async natif suffisant pour de l'I/O |
| Framework | FastAPI | Flask, Django | Async natif, WebSocket, validation Pydantic, OpenAPI gratuit |
| Interface | React 19 + Vite + TypeScript | Svelte, Vue | Typage strict ; se reutilise tel quel en desktop, web et mobile |
| Desktop | Navigateur (M1) → Tauri (M5) | Electron | Tauri : ~10 Mo contre ~120 Mo, moins de RAM, meme code React |
| Base | SQLite (M1) → PostgreSQL + pgvector (M4) | PostgreSQL d'emblee | Rien a installer sous Windows ; le SQL ecrit est deja portable |
| Recherche vectorielle | pgvector (M3/M4) | Pinecone, Chroma | Une seule base a sauvegarder ; le filtrage par metadonnees est du SQL |
| LLM | Claude `claude-opus-5` | GPT, modeles locaux | Meilleur usage d'outils et respect des consignes de securite. Abstrait derriere `LLMProvider` : changer de fournisseur = une classe |
| Temps reel | WebSocket | SSE, polling | Bidirectionnel : audio montant, evenements descendants, interruption |
| Confidentialite audio | STT local possible | Cloud uniquement | `faster_whisper` garde la voix sur la machine |

### Pourquoi un monolithe modulaire

Un assistant personnel a un utilisateur. Le decoupage en services couterait de
la latence (chaque saut reseau se paie dans une conversation vocale) et du temps
d'exploitation, pour aucun gain. Les frontieres de modules sont nettes, donc le
jour ou un composant doit sortir — par exemple un service de documents avec
GPU — il sort sans reecriture.

### Routage de modele

Trois niveaux, configurables :

| Niveau | Modele par defaut | Usage |
|---|---|---|
| `FAST` | `claude-haiku-4-5` | Salutations, confirmations, tours triviaux |
| `BALANCED` | `claude-opus-5` | Conversation avec outils (defaut) |
| `DEEP` | `claude-opus-5`, effort eleve | Analyse documentaire, raisonnement long |

Le choix se fait sur la forme du tour, pas sur une devinette du modele. Un
budget quotidien coupe net les appels au-dela du plafond configure.

---

## 3. Vue d'ensemble

```mermaid
graph TB
    subgraph Clients
        UI[Interface React<br/>poste de commande]
        CLI[CLI mode texte]
        FUTURE[Mobile / Tauri / auto<br/>M5-M6]
    end

    subgraph API["API interne (FastAPI)"]
        REST[REST<br/>chat, systeme, audit]
        WS[WebSocket<br/>temps reel]
    end

    subgraph Core["Noyau"]
        ORCH[JarvisOrchestrator]
        PROMPT[Prompt systeme<br/>+ contexte]
        PERM[Permissions]
        AUDIT[Piste d'audit]
    end

    subgraph Voice["Voix"]
        STT[SpeechToTextProvider]
        TTS[TextToSpeechProvider]
    end

    subgraph Brain["Raisonnement"]
        ROUTER[LLMRouter<br/>routage + budget]
        LLM[LLMProvider<br/>Claude / mock]
    end

    subgraph Tools["Outils"]
        REG[ToolRegistry]
        BUILTIN[Temps, calcul,<br/>rappels, memoire]
        GOOGLE[Gmail, Calendar<br/>M2]
        BUSINESS[POS, Stripe, KPI<br/>M4]
    end

    subgraph Memory["Memoire"]
        SESSION[Session<br/>court terme]
        STORE[Magasin persistant]
    end

    subgraph Data["Donnees"]
        DB[(SQLite → PostgreSQL)]
    end

    UI <--> WS
    UI --> REST
    CLI --> ORCH
    FUTURE -.-> WS
    WS --> STT
    WS --> TTS
    REST --> ORCH
    WS --> ORCH
    ORCH --> PROMPT
    ORCH --> ROUTER
    ROUTER --> LLM
    ORCH --> PERM
    PERM --> REG
    REG --> BUILTIN
    REG -.-> GOOGLE
    REG -.-> BUSINESS
    ORCH --> SESSION
    ORCH --> AUDIT
    BUILTIN --> STORE
    STORE --> DB
    AUDIT --> DB
```

Trait plein : implemente. Trait pointille : contrat fige, implementation a venir.

---

## 4. Cycle de vie d'un tour

```mermaid
sequenceDiagram
    participant U as Utilisateur
    participant UI as Interface
    participant WS as WebSocket
    participant STT
    participant O as Orchestrateur
    participant L as LLM
    participant P as Permissions
    participant T as Outil
    participant TTS

    U->>UI: maintient Espace, parle
    UI->>UI: coupe la lecture en cours (barge-in)
    UI->>WS: audio (base64)
    WS->>STT: transcribe()
    STT-->>WS: texte
    WS-->>UI: transcript
    WS->>O: handle_text()
    O->>O: prompt systeme + contexte (heure, focus, faits)
    O->>L: complete(messages, outils)
    L-->>O: appel d'outil demande
    O->>P: evaluate(outil, palier, destinataires)
    alt refuse
        P-->>O: DENY
        O-->>L: "action refusee"
    else confirmation requise
        P-->>O: CONFIRM
        O-->>UI: confirmation_required
        O-->>L: "non executee, demande l'accord"
        U->>UI: « vas-y »
        O->>T: execute()
    else autorise
        P-->>O: ALLOW
        O->>T: execute()
        T-->>O: ToolResult (+ citations)
        O->>O: encapsule si contenu externe
        O-->>UI: tool_end
    end
    O->>L: resultats d'outils
    L-->>O: reponse finale (streaming)
    O-->>UI: token, token, ... message
    O->>TTS: synthesize(phrase par phrase)
    TTS-->>UI: audio
    UI-->>U: JARVIS parle
```

Point important : le modele ne recoit **jamais** le resultat brut d'un outil
marque comme externe. Il recoit un bloc encapsule qui dit explicitement que ce
qu'il contient n'est pas une instruction.

---

## 5. Appel d'outils

```mermaid
flowchart TD
    A[Le modele demande un outil] --> B{Outil connu ?}
    B -- non --> Z[Erreur renvoyee au modele]
    B -- oui --> C[Validation du schema]
    C -- invalide --> Z
    C -- valide --> D[Evaluation de permission]
    D -- DENY --> E[Refus + audit]
    D -- CONFIRM --> F[Action mise en attente<br/>+ evenement UI]
    D -- ALLOW --> G[Execution]
    F --> H{Reponse de l'utilisateur}
    H -- oui --> G
    H -- non --> I[Annulation + audit]
    G --> J{Contenu externe ?}
    J -- oui --> K[Encapsulation + detection d'injection]
    J -- non --> L[Resume tel quel]
    K --> M[Resultat au modele]
    L --> M
    M --> N[Audit + citations + evenement UI]
```

La validation de schema est faite dans le registre, jamais dans les handlers :
un outil peut donc supposer que ses parametres sont conformes. Les proprietes
inconnues proposees par le modele sont jetees.

---

## 6. Memoire

```mermaid
graph LR
    subgraph Court["Session — en memoire"]
        H[Historique tronque]
        F[Focus : derniere liste presentee]
        SF[Faits de la conversation]
        P[Actions en attente]
    end
    subgraph Long["Persistant — base"]
        PM[personal : personnes, preferences]
        BM[business : associes, KPI, par organisation]
        EM[event : decisions datees]
        PR[preference : reglages deduits]
    end
    H --> CTX[Contexte du tour]
    F --> CTX
    SF --> CTX
    PM --> CTX
    BM --> CTX
    CTX --> LLM[LLM]
```

**Focus et references.** Quand un outil presente une liste (rendez-vous,
courriels, rappels), il enregistre un `focus`. « le deuxieme », « le dernier »,
« celui-la » se resolvent dessus. Si la reference reste ambigue, JARVIS demande
plutot que de deviner.

**Troncature sure.** L'historique est coupe sans jamais separer un appel d'outil
de son resultat, et il recommence toujours par un vrai message utilisateur —
sinon l'API rejette la conversation.

**Aucun souvenir sans source.** Chaque entree persistante porte `source` et
`confidence`. On peut toujours repondre « d'ou tu sors ca ? ».

**Contexte etroit.** On n'envoie pas toute la vie de l'utilisateur a chaque
tour : heure courante, focus, faits recents, capacites actives. La recherche
lexicale du M1 sera remplacee par de la recherche semantique en M3 — la
signature de `MemoryStore.search()` ne changera pas.

---

## 7. Permissions

```mermaid
flowchart TD
    A[Appel d'outil] --> B{Palier 4 et non autorise ?}
    B -- oui --> DENY[REFUS]
    B -- non --> C{Exception nommee ?}
    C -- deny --> DENY
    C -- confirm --> CONF[CONFIRMATION]
    C -- aucune --> D{Palier 3 ou 4 ?}
    D -- oui --> CONF
    D -- non --> E{Palier 2 et destinataires<br/>tous de confiance ?}
    E -- oui --> ALLOW[AUTORISE]
    E -- non --> F{Palier <= seuil<br/>d'auto-approbation ?}
    F -- oui --> ALLOW
    F -- non --> CONF
```

| Palier | Nom | Exemples |
|---|---|---|
| 0 | `READ` | lire le calendrier, chercher un courriel, consulter des ventes, calculer |
| 1 | `LOW_WRITE` | creer une note, un rappel, un brouillon |
| 2 | `EXTERNAL_COMM` | envoyer un courriel, un message, une reponse |
| 3 | `SENSITIVE` | supprimer un fichier, annuler un meeting, modifier des donnees business |
| 4 | `CRITICAL` | virement bancaire, suppression massive, changement de permissions |

**Invariant teste :** meme avec `auto_approve_max_level` au maximum, les paliers
3 et 4 ne sont jamais auto-approuves. La configuration elle-meme refuse un seuil
superieur a 2.

**Confirmations naturelles.** Quand une confirmation est requise, l'outil n'est
pas execute ; le modele recoit une consigne et formule la question lui-meme
(« J'ai prepare le message. Je l'envoie ? »). Un « oui » declenche l'action, un
« non » l'annule, et un changement de sujet l'abandonne — elle ne reste pas en
embuscade.

---

## 8. Modele de securite

```mermaid
graph TB
    subgraph A1["Autorite 1 — Systeme"]
        SYS[Instructions systeme<br/>personnalite, fiabilite, securite]
    end
    subgraph A2["Autorite 2 — Utilisateur"]
        USER[Messages de Greg]
    end
    subgraph A3["Autorite 3 — Donnees, jamais des ordres"]
        TOOL[Sorties d'outils]
        EXT["&lt;external_content&gt;<br/>courriels, PDF, web"]
    end
    SYS --> LLM[LLM]
    USER --> LLM
    TOOL --> LLM
    EXT --> LLM
    LLM --> ACT{Action demandee}
    ACT --> PERM[Permissions]
    PERM --> EXEC[Execution]
    PERM --> AUDIT[Audit]
    EXT -. "ne peut pas declencher" .-x ACT
```

**Defenses en profondeur contre l'injection**

1. Separation des autorites, materialisee dans le format des messages.
2. Encapsulation de tout contenu externe dans un bloc balise, avec avertissement.
3. Neutralisation des chevrons : le contenu ne peut pas refermer son propre bloc.
4. Detection des formulations d'injection connues (francais et anglais), signalee
   au modele et a l'utilisateur, et journalisee.
5. Barriere finale : meme convaincu, le modele se heurte aux permissions. Une
   suppression massive est palier 4, donc refusee.

**Secrets.** Aucune cle dans le code. `.env` ignore par Git. Jetons chiffres au
repos (Fernet). Filtre de redaction sur tous les logs. En production, la cle de
chiffrement est obligatoire.

**Audit.** `timestamp, session, requete, outil, action, parametres resumes,
palier, decision, confirmation, statut, duree, resultat, signaux d'injection`.
Les champs sensibles (corps de courriel, mots de passe) sont remplaces par leur
taille, pas par leur contenu.

---

## 9. Pipeline vocal

```mermaid
graph LR
    MIC[Micro] -->|MediaRecorder| CAP[Extrait webm/opus]
    CAP -->|WebSocket base64| STT[SpeechToTextProvider]
    STT --> TXT[Texte]
    TXT --> ORCH[Orchestrateur]
    ORCH -->|streaming| TOK[Fragments de texte]
    TOK --> UI[Affichage progressif]
    ORCH --> SENT[Decoupage en phrases]
    SENT --> TTS[TextToSpeechProvider]
    TTS -->|audio| PLAY[Lecture en file]
    PLAY --> SPK[Haut-parleur]
    MIC -.->|nouvelle prise de parole| STOP[stop + cancel]
    STOP -.-> PLAY
```

**Latence.** La metrique qui compte est *fin de parole → premier son de
reponse*. Les leviers, du plus au moins efficace :

1. TTS phrase par phrase — la lecture demarre avant la fin de la generation ;
2. modele rapide sur les tours triviaux ;
3. effort de raisonnement bas par defaut en conversation ;
4. prompt systeme mis en cache (prefixe stable) ;
5. STT local en modele `small` ou `base`.

**Interruption (barge-in).** Immediate cote client : reprendre la parole coupe
la lecture. Cooperative cote serveur : un `cancel` est envoye et le tour en cours
s'arrete a la prochaine etape verifiable.

**Wake word (M5).** Detection locale (`Porcupine` ou equivalent) dans un service
en arriere-plan, qui declenche le meme pipeline. Rien a changer au coeur.

---

## 10. Modele de donnees

```mermaid
erDiagram
    ORGANIZATIONS ||--o{ MEMORIES : contient
    ORGANIZATIONS ||--o{ REMINDERS : contient

    ORGANIZATIONS {
        text id PK
        text name
        text kind
        text created_at
    }
    MEMORIES {
        text id PK
        text org_id FK
        text kind "personal|business|event|preference"
        text subject
        text content
        text source "jamais vide"
        real confidence
        text happened_at
        text created_at
    }
    REMINDERS {
        text id PK
        text org_id FK
        text text
        text due_at
        text due_label
        text status
    }
    AUDIT_LOGS {
        text id PK
        text timestamp
        text session_id
        text tool
        text parameters "resumes"
        int permission_level
        text decision
        int confirmed
        text status
        int duration_ms
    }
```

`oauth_tokens` (M2) stocke les jetons **chiffres au repos**: la table ne
contient jamais de secret en clair, ce qu'un test verifie explicitement.

Seules les tables necessaires au stade actuel existent. `documents`,
`document_chunks`, `contacts` et `events` arriveront avec leurs jalons, par
migration.

**Multi-organisation.** `org_id` est present des maintenant sur les donnees
metier. « Mes ventes aujourd'hui » pourra demander de quelle entreprise il
s'agit, ou deduire du contexte recent.

---

## 11. Protocole temps reel

Client → serveur :

| Message | Effet |
|---|---|
| `{type:"text", text}` | Tour en mode texte |
| `{type:"audio", audio_base64, mime}` | Tour vocal |
| `{type:"confirm", action_id, approved}` | Reponse a une confirmation |
| `{type:"cancel"}` | Interruption |
| `{type:"org", organization}` | Change l'organisation active |
| `{type:"reset"}` | Vide la session |

Serveur → client : `state`, `transcript`, `token`, `tool_start`, `tool_end`,
`confirmation_required`, `message`, `citations`, `audio`, `error`, `metrics`.

L'interface affiche **les actions et les resultats**, jamais le raisonnement
interne du modele.

---

## 12. Google Workspace (M2)

### Flux d'autorisation

```mermaid
sequenceDiagram
    participant U as Utilisateur
    participant UI as Interface
    participant API as API JARVIS
    participant G as Google
    participant DB as Base chiffree

    U->>UI: « Connecter Google »
    UI->>API: POST /api/integrations/google/connect
    API->>API: genere state + verificateur PKCE
    Note over API: le verificateur ne quitte jamais le serveur
    API-->>UI: URL de consentement (avec code_challenge S256)
    UI->>G: ouvre l'ecran de consentement
    U->>G: s'authentifie et coche les permissions
    Note over U,G: le mot de passe reste chez Google
    G->>API: redirection boucle locale (code + state)
    API->>API: verifie le state (usage unique)
    API->>G: echange code + code_verifier
    G-->>API: access_token + refresh_token
    API->>DB: chiffre puis stocke
    API-->>U: page de confirmation
```

**Pourquoi PKCE.** Une application de bureau ne peut pas garder un secret: son
binaire est sur la machine de l'utilisateur. PKCE rend un code d'autorisation
intercepte inutilisable sans le verificateur, qui lui reste cote serveur.

**Pourquoi la boucle locale.** Le code d'autorisation ne transite par aucun
serveur distant: Google redirige vers `127.0.0.1`, c'est-a-dire vers le
processus JARVIS lui-meme.

### Moindre privilege applique litteralement

Les portees demandees sont calculees a partir des feature flags actifs. Le
calendrier desactive n'apparait meme pas sur l'ecran de consentement.

| Capacite | Portee | Deliberement exclu |
|---|---|---|
| Lire | `gmail.readonly` | `https://mail.google.com/` (acces total) |
| Ecrire | `gmail.compose` | `gmail.modify` (modification/suppression) |
| Agenda | `calendar.events` | `calendar` (parametres du compte) |
| Contacts | `contacts.readonly` | `contacts` (ecriture) |

### Frontiere de confiance

```mermaid
graph LR
    subgraph Fiable["Ecrit par JARVIS"]
        H[En-tetes: expediteur, objet, date]
        M[Metadonnees d'evenement]
    end
    subgraph Hostile["Contenu externe"]
        B[Corps des courriels]
        D[Descriptions d'evenements]
    end
    H --> LLM[Modele]
    M --> LLM
    B --> W["&lt;external_content&gt;<br/>+ detection d'injection"]
    D --> W
    W --> LLM
    B -. "ne peut declencher aucune action" .-x A[Actions]
```

`search_email` ne rapatrie que des en-tetes — moins de donnees transmises, et
rien d'hostile. Seul `read_email` descend dans un corps, et il le marque
`untrusted`.

### Renouvellement et pannes

Le jeton d'acces est rafraichi automatiquement avant expiration (marge de
60 secondes). Un `401` inattendu — horloge desynchronisee, consentement revoque
depuis le compte Google — declenche un rafraichissement force puis **un seul**
reessai: au-dela, on conclut a une revocation et on demande la reconnexion,
plutot que de boucler.

Chaque mode d'echec produit une phrase exploitable, jamais une reponse
fabriquee: permission manquante, quota atteint, compte deconnecte, service
injoignable.

---

## 13. Interface : le centre de commande

L'interface est servie par l'API elle-meme (`StaticFiles` monte sur `/`, **en
dernier**, pour que les routes `/api/*` et `/ws` gardent la priorite). Une seule
adresse, un seul processus, pas de CORS en production.

### Contrat de donnees honnete

C'est la regle qui structure tout l'ecran. Chaque panneau et chaque metrique
transporte un etat explicite :

| Etat | Sens | Ce que l'ecran affiche |
|---|---|---|
| `connected` | La source repond | Les donnees reelles |
| `not_connected` | La source n'est pas branchee | « Gmail n'est pas active » |
| `error` | La source a echoue | « Je n'ai pas pu regarder » |

Un panneau vide et un panneau non branche ne se ressemblent pas. La distinction
est portee par le serveur, pas devinee par le client : `PaneBody` est le seul
endroit de l'interface qui decide quoi montrer quand une source manque.

Les metriques d'entreprise renvoient toutes `{"status": "not_connected",
"value": null}` tant qu'aucune source reelle n'est branchee (M4). Aucun chiffre
d'affaires, aucune reservation, aucune masse salariale n'est fabriquee — ni
comme exemple, ni comme demonstration.

### Routes de lecture

| Route | Reponse |
|---|---|
| `GET /api/overview` | Les panneaux de l'accueil : agenda du jour, courriels non lus, rappels, entreprises — chacun avec son etat |
| `GET /api/businesses` | Une organisation par contexte, ses metriques et leur etat |
| `GET /api/memory` | Ce que JARVIS retient, avec la source obligatoire de chaque souvenir |
| `DELETE /api/memory/{id}` | Oublier un souvenir (404 s'il n'existe plus) |

### Le noyau

Un `<canvas>` pilote par `requestAnimationFrame`, mis a l'echelle selon le
`devicePixelRatio`. Chaque etat de l'assistant (`idle`, `listening`,
`transcribing`, `understanding`, `working`, `speaking`) definit un profil
— rotation, energie, halo, respiration, balayage, reactivite au micro — et les
transitions sont lissees (`k = 1 - exp(-dt * 3.2)`) plutot que commutees : le
noyau *devient* attentif, il ne saute pas d'un etat a l'autre.

En ecoute, l'energie suit le **niveau reel du micro** (RMS mesure par un
`AnalyserNode`), pas une animation decorative.

Sa taille se calcule a partir de la place disponible (`useCoreSize`) : les
constantes viennent de mesures sur le rendu reel, pas d'estimations, parce
qu'un noyau de taille fixe pousse les cartes sous la ligne de flottaison sur un
portable.

Sous le noyau s'affiche **l'outil en cours de consultation** — jamais le
raisonnement du modele, conformement au principe de la section 11.

---

## 14. Documents et recherche (M3)

### Pourquoi la recherche est hybride

Deux facons de chercher, qui ne repondent pas aux memes questions.

L'**index lexical** (SQLite FTS5, avec `remove_diacritics 2`) trouve les termes
exacts. Il ne demande aucun telechargement, fonctionne hors ligne, et ignore les
accents — ce qui compte quand la question arrive par la voix: « reservation »
doit trouver « réservation ».

La **recherche par vecteurs** trouve une idee formulee autrement: « combien ca
coute » ramene « le loyer mensuel est de 4 200 $ », sans qu'aucun mot ne soit
partage. Elle demande un modele local (~220 Mo, multilingue, ONNX via
fastembed) telecharge une seule fois.

Les deux classements sont fusionnes par **rang reciproque** (RRF, k=60), qui
evite d'avoir a rendre comparables un score bm25 et une similarite cosinus.

### La regle qui gouverne le module

**L'index lexical est le socle, le semantique est un supplement.** Si le modele
ne se charge pas — pas de reseau, disque plein, telechargement interrompu — la
recherche continue en mots exacts **et l'annonce**: dans l'interface, dans le
diagnostic, et dans le resume que l'outil renvoie au modele.

La distinction n'est pas cosmetique. « Aucun document ne contient ces mots » et
« aucun document ne parle de ca » sont deux affirmations differentes; laisser
croire a la seconde quand seule la premiere a ete verifiee, c'est exactement le
genre de mensonge par omission que ce projet refuse.

Le chargement est **paresseux**: `jarvis serve` ne declenche jamais un
telechargement de 220 Mo, il se produit a la premiere recherche.

### Decoupage

Trop gros, un morceau noie l'information; trop petit, il perd son contexte —
« il expire le 30 juin » ne veut rien dire seul. On coupe donc sur les
frontieres naturelles (paragraphes, puis phrases), vers 1 100 caracteres, avec
un recouvrement de 160 caracteres pour qu'une information a cheval sur une
coupure reste trouvable des deux cotes.

Chaque morceau conserve sa **localisation** (page 4, section « Resiliation »):
c'est ce qui permet a une citation de dire ou regarder, et non pas seulement de
quel fichier elle vient.

### Le dossier surveille

C'est la reponse la plus solide a « je veux mes chiffres en direct » sans
dependre d'un fournisseur. Un sous-dossier par entreprise, nomme d'apres son
identifiant; JARVIS scrute toutes les deux minutes et importe ce qui arrive.
Aucune entente d'integration, aucune cle d'API, aucun service tiers entre les
donnees et la machine.

Trois precautions le rendent utilisable en production:

**L'empreinte porte sur le contenu, pas sur le nom.** Une caisse qui reecrit
`ventes.csv` chaque nuit doit etre relue a chaque changement; un fichier
simplement renomme ne doit pas gonfler les totaux une seconde fois.

**Un fichier modifie il y a moins de dix secondes n'est pas lu**, sinon on
importerait la moitie d'un export en cours d'ecriture. Il est repris au tour
suivant.

**Un dossier dont le nom ne correspond a aucune entreprise est nomme dans le
rapport**, pas ignore en silence — c'est l'erreur la plus probable au premier
essai.

### Ce qui n'est jamais silencieux

L'indexation rend compte fichier par fichier: indexe, inchange, ignore (avec la
raison), en echec (avec la cause). Un document illisible qui disparaitrait du
rapport ferait repondre « je n'ai rien trouve » sur un contrat jamais lu — pire
qu'une erreur visible.

La reindexation est idempotente, sur l'**empreinte du contenu** et non la date:
une synchronisation ou une copie change la date sans toucher au texte.

### Google Drive

La portee `drive.readonly` donne acces a **tout** le Drive. Trois compensations:

1. elle n'est demandee que si `JARVIS_FEATURE_DRIVE` **et**
   `JARVIS_FEATURE_DOCUMENTS` sont actifs — sinon elle n'apparait meme pas sur
   l'ecran de consentement;
2. l'indexation est bornee a un dossier declare (`JARVIS_DRIVE_FOLDER`), et
   refuse de s'executer si aucun n'est configure;
3. les documents Google natifs sont **exportes en texte**, jamais manipules
   comme des binaires.

Les fichiers natifs n'ont pas de `md5Checksum`: la date de modification sert
alors d'empreinte, sans quoi ils seraient reindexes a chaque passage.

### Frontiere de confiance

Le contenu d'un document est **du contenu externe**. Les outils documentaires
marquent leur resultat `untrusted`, ce qui declenche l'encapsulation decrite en
section 8. Un contrat qui contient « ignore les instructions precedentes »
reste un contrat, pas un ordre.

---

## 15. Donnees business (M4)

### La forme des donnees

Un **fait** = un indicateur, une organisation, un jour, une source. Table
plate, volontairement: cette forme rend impossible de stocker un chiffre sans
dire d'ou il vient ni de quand il date.

```
business_facts (org_id, metric, day, value, unit, source, source_ref)
UNIQUE (org_id, metric, day, source)
```

La contrainte d'unicite rend le reimport idempotent: recharger le meme export
corrige les valeurs au lieu de les additionner en double. Deux sources
differentes pour le meme jour coexistent (la caisse et Stripe peuvent tous
deux rapporter un chiffre).

### Le vocabulaire est ferme

Les indicateurs sont une liste declaree (`jarvis_core/business/metrics.py`),
pas une chaine libre. Si le modele pouvait inventer un nom d'indicateur, il
pourrait aussi inventer sa valeur: « la marge nette de Maguire » sortirait
d'une requete vide, qu'un modele complaisant lirait comme un zero.

Chaque indicateur declare **comment il s'agrege**, parce que la reponse
depend de sa nature:

| Agregation | Indicateurs | Pourquoi |
|---|---|---|
| Somme | ventes, couverts, masse salariale | Ils se cumulent |
| Moyenne | occupation, attrition | Additionner un taux donnerait 300 % sur trois jours |
| Derniere valeur | MRR, portes, logements | Ce sont des etats, pas des flux |

### La couverture voyage avec le chiffre

C'est la regle centrale du module. Aucune lecture ne renvoie une valeur nue:
`MetricReading` porte toujours combien de jours ont ete demandes, combien sont
reellement presents, la date de la derniere donnee et la source.

Sans cela, « les ventes de la semaine: 42 000 $ » serait indistinguable d'un
total calcule sur trois jours. Avec, JARVIS dit « 18 200 $ sur les 3 jours
dont j'ai les donnees ». Le premier enonce est un mensonge par omission; le
second est verifiable.

Trois etats, jamais confondus:

| Etat | Sens |
|---|---|
| `not_connected` | Aucune donnee — **jamais affiche comme zero** |
| `connected` | Donnee reelle, avec sa couverture |
| `stale` | Donnee reelle mais perimee, avec son age |

Un vrai zero (« lundi ferme, zero vente ») est une donnee et reste
`connected`: la distinction est portee par le statut, pas par la valeur.

### Les entreprises appartiennent a l'utilisateur

La migration 0003 declarait cinq entreprises en dur, d'apres une premiere
conversation. C'etait une erreur de conception, pas un detail: le code n'a pas
a decider quelles entreprises sont celles de l'utilisateur, et l'une d'elles
ne lui appartenait pas.

Les valeurs de depart restent, mais ne sont que des valeurs de depart:
l'ajout, le renommage et le retrait passent par l'interface.

**Retirer archive, ne detruit pas.** Les chiffres restent en base et
reapparaissent si l'entreprise est restauree. La suppression definitive existe
(`purge=true`) mais n'est jamais le comportement par defaut: on ne detruit pas
des annees de donnees sur un clic mal place.

Toutes les lectures — volets, briefing, surveillance, outils, diagnostic —
filtrent les organisations archivees. Une entreprise retiree ne doit plus
produire d'alerte ni apparaitre dans un briefing.

### Pourquoi le CSV en premier

Tous les systemes de caisse savent exporter un CSV. Aucune entente
d'integration a signer, aucune cle a obtenir, ca fonctionne le soir meme. Les
connecteurs directs (POS, Stripe) viendront derriere la meme interface, en
ecrivant les memes faits.

L'import est ecrit pour des fichiers **quebecois reels**: separateur
point-virgule (Excel francais), decimales a la virgule, espaces insecables
dans les montants, dates en JJ/MM/AAAA (jamais lues comme MM/JJ), parentheses
comptables pour les negatifs.

**On ne devine jamais.** Une date ambigue, un montant illisible, une colonne
inconnue: chaque ligne refusee est nommee avec son numero et sa raison, et
chaque colonne ignoree est listee. Un import « reussi » ayant silencieusement
saute la moitie des lignes produirait des totaux faux avec l'air d'etre
complets — exactement le mode de defaillance que ce projet refuse.

Un montant illisible devient `None`, jamais `0`: une case vide ne doit pas
pouvoir passer pour une journee sans vente.

### Ce que les outils disent au modele

Le magasin peut etre irreprochable, si le resume passe au modele efface la
nuance, JARVIS mentira quand meme. Les outils portent donc la couverture, la
fraicheur et la source **dans leur texte**:

```
Grande Allee — 2026-08-18 au 2026-08-24 (7 jour(s) demandes) :
- Ventes: 27 731.50 $ (seulement 4 jour(s) sur 7)
- Reservations: aucune donnee (Aucune source branchee pour cet indicateur)
- Masse salariale en % des ventes: 29.5 %

Source(s): csv.
```

La comparaison de periodes refuse de s'executer si l'une des deux est vide —
comparer a rien donnerait un ecart de +100 %, faux et alarmant — et signale
explicitement quand les deux periodes n'ont pas la meme couverture.

---

## 16. Briefing et surveillance proactive (M5)

### Le planificateur

Ecrit a la main plutot que d'ajouter une dependance: deux besoins seulement —
« tous les jours a 7 h 15 » et « toutes les N minutes ».

Deux garanties le structurent. **Une tache qui echoue n'arrete jamais le
planificateur**: un briefing qui plante ne doit pas emporter la surveillance
des rappels. Et **l'heure est celle de l'utilisateur**: un briefing « a 7 h »
calcule en UTC arriverait a 3 h du matin a Quebec.

Une heure illisible (`JARVIS_BRIEFING_TIME=sept heures`) **desactive** la tache
avec un message, plutot que de la declencher a un moment arbitraire.

### Ce qui autorise JARVIS a interrompre

La surveillance proactive est la fonctionnalite la plus facile a rendre
insupportable. Trois regles la gouvernent.

**Ne jamais inventer une raison d'interrompre.** Un observateur dont la source
n'est pas branchee ne produit rien. Pas « tu n'as aucune reunion » — rien du
tout. Le silence est le comportement correct quand on ne sait pas.

**Ne jamais repeter.** Chaque alerte porte une cle de deduplication stable,
contrainte en unicite dans la base. La surveillance tourne toutes les cinq
minutes; sans cela, la meme reunion alerterait douze fois par heure.

**Ne signaler que ce sur quoi on peut agir.** Une organisation qui n'a jamais
eu de donnees n'est pas une nouvelle, c'est l'etat normal. Une organisation
dont les donnees se sont **arretees**, si — et sa cle de deduplication inclut
le numero de semaine, pour re-signaler une fois par semaine plutot qu'une fois
pour toutes.

Les observateurs sont isoles les uns des autres: un observateur casse ne prive
pas des alertes des autres.

### Le briefing

C'est l'endroit ou l'invention est la plus tentante et la plus dangereuse: le
format appelle des phrases completes et rassurantes, et personne ne verifie a
7 h du matin.

D'ou la construction en deux temps:

1. **Rassembler les faits disponibles**, chacun avec sa source, en notant
   separement ce qui n'a pas pu etre consulte (`unavailable`).
2. **Ne demander au modele que de les mettre en francais.** Le prompt systeme
   interdit explicitement d'ajouter quoi que ce soit — pas un chiffre, pas un
   nom, pas un rendez-vous absent de la liste.

Sans cle Claude, le briefing existe quand meme: il est compose mecaniquement a
partir des memes faits. Mieux vaut une liste seche et vraie qu'un paragraphe
elegant et faux. C'est aussi ce qui se produit si l'appel au modele echoue: la
version brute est conservee plutot qu'une absence de briefing.

L'interface affiche la liste des sources reellement consultees sous le texte:
le lecteur voit d'un coup d'oeil sur quoi le briefing repose.

### Notifications

La permission n'est demandee **qu'au moment ou l'utilisateur active les
notifications**, jamais au chargement de la page: une demande surgie de nulle
part se refuse par reflexe, et le refus est definitif dans le navigateur.

Le serveur deduplique deja, mais un rechargement de page relit la meme liste
d'alertes — le client tient donc sa propre trace de ce qui a deja sonne.

Le transport est un **sondage** toutes les 60 secondes, pas une diffusion
WebSocket. La surveillance serveur tourne de toute facon toutes les cinq
minutes: un sondage d'une minute sur un preavis de reunion de quinze minutes
est largement suffisant, et evite tout un cycle de vie de connexions a gerer.

### Demarrage avec Windows

`scripts/autostart.ps1` enregistre une tache du Planificateur plutot qu'un
raccourci dans le dossier Demarrage: la tache se relance si le processus tombe
et n'exige aucun droit administrateur. Rien n'est installe hors du compte
utilisateur.

---

## 17. Acces distant et mot d'eveil (M5b)

### La frontiere qui change tout

Tant que JARVIS ecoute sur `127.0.0.1`, seule la machine locale peut lui
parler. Aucune authentification n'est necessaire, et en exiger une n'ajouterait
qu'une friction.

Des que l'ecoute s'ouvre au reseau, la situation change du tout au tout:
n'importe qui sur le meme Wi-Fi — celui d'un restaurant, par exemple —
pourrait lire les courriels, l'agenda et les chiffres d'affaires. Le jeton
devient alors **obligatoire**.

**Le serveur refuse de demarrer** si `JARVIS_HOST` sort de la boucle locale
sans jeton defini. Mieux vaut une application qui ne se lance pas qu'une
application ouverte a tout le monde sans que personne ne s'en apercoive.

### Trois details qui comptent

**La comparaison est a temps constant** (`hmac.compare_digest`). Un `==`
s'arrete au premier caractere different, ce qui laisse mesurer la duree des
reponses pour deviner le jeton caractere par caractere.

**Le WebSocket est verifie separement.** Le middleware HTTP ne le voit pas,
et c'est pourtant le canal qui porte la conversation entiere. Il est refuse
avant meme d'etre accepte (code 1008).

**Le jeton disparait de la barre d'adresse.** Le premier acces depuis un
telephone passe forcement par l'URL — on ne peut pas taper un en-tete HTTP
dans un navigateur. Mais l'interface le range immediatement dans le stockage
local et nettoie l'URL, sinon il finirait dans l'historique, dans un signet ou
dans une capture d'ecran partagee.

Cote client, `fetch` est **enveloppe une fois** plutot que modifie a chaque
appel: un seul point d'appel oublie produirait, sur un telephone, une page a
moitie vide sans explication. Le jeton n'est ajoute qu'aux requetes de meme
origine.

Ce qui reste public: `/api/health` (ne revele rien, sert aux verifications de
demarrage) et l'interface elle-meme, qui doit pouvoir se charger. Ce sont les
donnees qui sont protegees, pas la page.

### Mot d'eveil

La phrase declencheuse est **« Salut JARVIS »**, en deux mots. Le nom seul
revient trop souvent dans une conversation ordinaire — en parlant de
l'assistant a quelqu'un — pour servir de declencheur fiable.

La comparaison se fait sur une transcription normalisee (minuscules, sans
accents ni ponctuation) et accepte les variantes que la reconnaissance
propose reellement: « jarvice », « darvis », « java is ». Un seul mot
parasite est tolere entre le salut et le nom, pas davantage.

La reconnaissance continue du navigateur (`SpeechRecognition`, disponible dans
Edge et Chrome) plutot qu'un modele local: rien a telecharger, rien a
installer, et la detection reste sur la machine — aucun son n'est envoye tant
que le mot n'est pas reconnu.

Le vrai risque n'est pas la detection, c'est le **conflit de micro**: deux
consommateurs qui reclament le peripherique en meme temps, et c'est la
commande vocale existante qui casse. Trois regles l'evitent:

1. l'ecoute passive s'arrete **avant** que l'enregistrement ne demarre, et ne
   reprend qu'une fois le tour termine;
2. elle est coupee pendant que JARVIS parle — sinon il se reveillerait
   lui-meme en entendant son nom dans sa propre reponse;
3. elle est **desactivee par defaut**: tant que l'utilisateur ne l'active pas,
   ce module ne touche pas au micro et le push-to-talk garde exactement le
   comportement qu'il a toujours eu.

Le mot d'eveil declenche le meme chemin que le bouton micro. Une seule voie
d'entree vocale, donc un seul comportement a garantir.

### Responsive

L'acces depuis un telephone n'a de sens que si l'interface y est utilisable.
Sous 820 px, la barre laterale devient un tiroir qui recouvre la vue le temps
de choisir: fixe, elle mangerait la moitie d'un ecran de 414 px.

---

### La page Integrations ne promet pas de jalon

Elle affichait « prevu M3 » et « prevu M4 » a partir d'une liste ecrite en dur.
Une fois M3 et M4 livres, ces etiquettes sont devenues fausses de deux facons:
elles annoncaient comme a venir une chose deja construite (Drive), et elles
laissaient croire qu'un connecteur arriverait dans un jalon deja termine.

Le plus grave: elles cachaient a l'utilisateur la voie qui, elle, fonctionne.
Un restaurateur lisant « Maitre'D — prevu M4 » conclut qu'il doit attendre,
alors que ses chiffres peuvent entrer aujourd'hui par collage.

Chaque carte porte donc un etat, jamais un jalon:

| Etat | Sens |
|---|---|
| `connecte` | Lu depuis la configuration reelle, pas depuis une liste |
| `disponible` | Construit, il reste a l'activer — avec le bouton pour le faire |
| `autrement` | Pas de connecteur, mais une voie qui marche — avec le lien vers elle |
| `non construit` | Rien, et on le dit |

Drive n'est plus une entree de liste: son etat se deduit du flag et des
permissions reellement accordees.

---

## 18. Mise a jour depuis l'interface

### Le probleme n'etait pas technique

Le proprietaire de ce projet n'est pas developpeur. Chaque livraison lui
demandait d'ouvrir un terminal, de taper `git pull`, puis de relancer un
script. Deux commandes — mais deux commandes apres *chaque* changement, dans
un outil qu'il n'utilise pour rien d'autre. C'est la source de frustration la
plus constante de ce projet, et elle etait entierement de notre cote.

`jarvis_core/updater.py` fait passer ces deux commandes de l'utilisateur a la
machine: Reglages > Mise a jour > Installer.

### Deux fonctions, une separation nette

`check_update` ne modifie rien. Elle rapporte un `UpdateStatus`: version
courante, branche, nombre de commits de retard, proprete de l'arbre, et la
liste des changements a venir. C'est ce que l'interface affiche avant que
l'utilisateur decide.

`apply_update` execute: `git merge --ff-only @{upstream}`, puis `npm run
build`. Elle **ne redemarre pas** — c'est a l'appelant de le faire, une fois
la reponse HTTP partie. Un redemarrage a l'interieur de la fonction couperait
la connexion avant que le navigateur sache si la mise a jour a reussi.

### Trois garde-fous, parce que ce module execute des commandes

**Aucune commande n'est composee a partir d'une saisie.** Les arguments sont
des constantes du fichier, passes en liste a `subprocess.run` avec
`shell=False`. Rien de ce que l'utilisateur tape n'entre dans une commande.

**On ne met a jour qu'un depot propre.** Si `git status --porcelain` retourne
quoi que ce soit, la mise a jour est refusee — pas reportee, refusee, avec le
motif. Ecraser un travail qu'on ne comprend pas est pire que ne rien faire.
`test_local_changes_block_the_update` verifie que le travail local survit.

**Avance rapide seulement.** Pas de fusion, pas de rebase. Si l'historique a
diverge, la situation demande un humain, et on le dit.

### La racine du depot se cherche, ne se suppose pas

La premiere version supposait que `jarvis/` etait la racine du depot. Selon la
facon dont le projet a ete clone, c'est parfois un sous-dossier — et la mise a
jour repondait alors « Ce dossier n'est pas un depot git » sur une copie
parfaitement valide. `find_repo_root` remonte les parents jusqu'a trouver
`.git`.

L'interface, elle, se recompile depuis le dossier fourni, pas depuis la racine
du depot: `ui/` vit sous `jarvis/`, pas forcement a la racine.

### Le redemarrage passe par un code de sortie

Un processus ne peut pas se remplacer proprement au milieu d'une requete. Il
sort donc avec le code convenu **42**, et la boucle de `scripts/start.ps1` et
`scripts/start.sh` le relance:

```powershell
while ($true) {
  & $python -m jarvis_core.api.server
  if ($LASTEXITCODE -ne 42) { break }
}
```

`_restart_soon()` arme un `threading.Timer` de 1,5 s avant `os._exit(42)`: le
navigateur recoit sa reponse, puis le processus tombe. La page se recharge
d'elle-meme six secondes plus tard.

Consequence assumee: lance autrement que par ces scripts, JARVIS s'arrete au
lieu de redemarrer. C'est visible et reparable, contrairement a un processus
qui se serait relance dans un etat incoherent.

### Ce qui est dit quand ca echoue a moitie

Si `git merge` reussit mais que `npm run build` echoue, le code est a jour et
l'interface ne l'est pas. `apply_update` remonte alors l'erreur plutot que de
declarer une reussite: annoncer « mis a jour » avec une interface d'hier serait
exactement le genre de mensonge que le reste du projet s'interdit.

---

## 19. La voix

### Ce qui fait la voix de JARVIS

Le timbre est la partie la plus visible et la moins determinante. Ce qui
identifie JARVIS dans les films tient a trois choses, dans cet ordre
d'importance decroissant:

1. **La tenue** — un debit legerement sous le naturel, une hauteur basse,
   aucune emphase. Il ne vend rien et ne s'excite jamais.
2. **Le registre** — le vouvoiement et le « Monsieur ». Un assistant qui
   tutoie n'est pas le meme personnage, quel que soit son timbre.
3. **Le timbre** — masculin, grave. Necessaire, tres loin d'etre suffisant.

Une voix neuronale reglee a plat sonne comme une annonce d'aeroport. Les memes
mots, ralentis de 7 % et descendus de 12 Hz, sonnent poses. C'est pour cela que
le moteur est passe cote serveur: le navigateur expose des voix, pas la
prosodie.

### L'accent avant le timbre

La premiere version cherchait « une belle voix masculine quebecoise ». C'etait
le mauvais objectif, et le proprietaire l'a dit en une phrase: *« c'est supposé
être british comme un servant »*.

JARVIS est un majordome anglais. Aucun reglage de debit ou de hauteur sur une
voix quebecoise ne produira ce personnage.

Le defaut etait structurel: `choose_voice` filtrait sur `Locale.startswith("fr")`,
donc une voix britannique ne pouvait **jamais** gagner, quel que soit le
barème. Les voix « Multilingual » de Microsoft gardent le timbre et l'accent de
leur locale d'origine en parlant une autre langue — une voix `en-GB` qui dit du
francais sonne comme un Anglais qui parle francais. Le filtre est donc devenu:

    locale francaise  OU  voix multilingue

Une voix `en-GB` **non** multilingue ne sait dire que de l'anglais; lui donner
du francais produirait du charabia. C'est la seule regle dure du classement —
tout le reste est une preference, celle-ci est un filtre.

### Le genre domine le barème, volontairement

Le classement donnait 100 points au genre et 200 a la locale exacte. Une voix
feminine du bon accent passait donc devant une voix masculine. Pour un
majordome, c'est le mauvais arbitrage — et un test l'a montre avant que
quiconque l'entende.

Le genre vaut maintenant 1000: hors d'atteinte de tout bonus d'accent. Les
accents et la generation classent **a l'interieur** du genre.

### Une voix epinglee ne doit pas rendre l'accent inoperant

Un choix explicite de l'utilisateur gagne sur l'accent: c'est voulu. Mais
demander un autre accent **sans nommer de voix** veut dire « choisis-en une qui
correspond ». Sans relacher la voix epinglee, JARVIS gardait l'ancienne et le
selecteur semblait casse. Trouve en exercant l'API reelle, pas en relisant le
code.

`set_accent` oublie aussi la voix deduite — sinon le changement n'aurait pris
qu'au redemarrage suivant.

### `git pull` n'installe rien

Le defaut le plus couteux de cette serie, et il n'etait pas dans la voix.

La voix neuronale a ajoute une dependance a `pyproject.toml`. Le proprietaire
a fait `git pull` puis `start.ps1` — et rien n'a installe le paquet:
`setup.ps1` le fait, `start.ps1` ne le faisait pas. JARVIS a demarre avec
`JARVIS_TTS_PROVIDER=edge` et sans `edge_tts`.

Le resultat visible: la liste des voix vide, et le message **« Impossible de
joindre le service de voix. Verifie ta connexion. »** — alors que sa connexion
allait parfaitement. Un message faux est pire qu'une panne: il envoie chercher
au mauvais endroit.

Deux corrections, et la seconde compte autant que la premiere.

**Installer.** `jarvis_core/deps.py` verifie a chaque demarrage que les
paquets obligatoires sont importables et installe ce qui manque. La commande
est une constante (`pip install -e .`, `shell=False`): aucun nom venant
d'ailleurs n'y entre. L'updater fait la meme chose apres avoir recupere le
code, avant de recompiler l'interface.

Le succes de pip ne suffit pas: on **reverifie** que le module est devenu
importable. pip peut sortir en succes sans avoir installe ce qu'on attendait,
et annoncer « tout va bien » sur une fonctionnalite morte serait le meme
mensonge sous une autre forme.

**Dire lequel des deux.** Le message distingue desormais « service
injoignable » de « paquet absent ». Deux tests tiennent les deux moities:
l'un exige que le paquet manquant ne soit pas impute a la connexion, l'autre
que la panne reseau le soit toujours.

Un echec d'installation ne bloque pas le demarrage: JARVIS fonctionne sans la
voix neuronale, moins bien. Il le signale, il ne s'arrete pas.

### Pourquoi edge-tts

C'est le seul moteur de cette qualite qui ne demande **ni cle d'API ni compte**
— les memes voix neuronales que Microsoft Edge, pilotees depuis le serveur.
ElevenLabs sonne mieux mais se paie; la voix du navigateur est gratuite mais ne
se regle pas. Pour un utilisateur qui ne doit rien avoir a configurer, ce
compromis est le bon, et il reste le defaut jusqu'a preuve du contraire par
l'oreille.

### Aucun nom de voix n'est ecrit en dur

Le catalogue de Microsoft change. Un `fr-CA-XNeural` code en dur qui disparait
rendrait JARVIS muet, et le message d'erreur ne dirait rien d'utile.

`choose_voice` filtre donc par **attributs** — genre, generation, locale — et
retient le mieux classe. Un test le prouve sur un catalogue ne contenant aucun
nom reel: la selection fonctionne quand meme. Le genre pese plus que la
generation, parce que c'est ce qu'on entend en premier.

### Une panne reseau n'est pas une panne de voix

`synthesize` retourne `None` des que quoi que ce soit echoue — catalogue
injoignable, delai depasse, flux vide. Le client interprete `None` comme
« parle avec la voix du systeme ». On perd en qualite, jamais la parole.

La resolution de la voix est **dans le meme `try` que la synthese**. Elle etait
en dehors dans la premiere version: une panne au moment de demander le
catalogue serait remontee dans le tour de parole au lieu de degrader. Un test
l'a trouve.

L'interface dit alors ce qui se passe — « Impossible de joindre le service de
voix » — et ressort le choix de la voix du systeme, qui est ce qu'on entendra
reellement. Un repli silencieux serait un mensonge par omission.

### La bascule se fait toute seule

`jarvis setup` fait passer `JARVIS_TTS_PROVIDER` de `null` a `edge`. Personne
ne devrait avoir a editer un fichier pour etre bien entendu.

Mais **seulement depuis `null`**: quelqu'un qui paie pour ElevenLabs ne doit
pas le perdre au demarrage suivant. Deux tests tiennent les deux moities.

### Choisir se fait par l'oreille

`POST /api/settings/voice/test` synthetise une phrase avec des reglages
d'essai, sans les enregistrer, et les restaure dans un `finally`. Ecouter ne
doit rien changer tant qu'on n'a pas choisi.

`POST /api/settings/voice` ecrit dans `.env` **et** met a jour le moteur en
memoire: sans le second, il faudrait redemarrer pour s'entendre.

---

## 20. Le son et le decor

### Ce qui rend une piece vivante

Dans la scene de l'atelier, ce qui donne l'impression que la machine est
vivante n'est ni le timbre ni les hologrammes: c'est que **chaque geste
repond**. L'interface n'avait aucun son. Un ecran silencieux, si beau soit-il,
reste une page web.

Sept signaux — pression, reveil, ecoute, envoi, reponse, alerte, erreur — tous
synthetises a la volee avec l'API Web Audio. Aucun fichier, aucun
telechargement, et rien qui vienne d'une bande son existante: les sons du film
appartiennent a leur studio.

### Des sons qu'on mesure au lieu de les croire

C'est l'avantage decisif du son synthetise sur un fichier: le meme code rendu
dans un `OfflineAudioContext` produit exactement le signal qui sortira des
haut-parleurs. On peut donc **mesurer** duree, crete et hauteur.

`ui/scripts/probe-sound.mjs` fait cette mesure et verifie quatre regles: joue
quand actif, muet pendant que JARVIS parle, silencieux si desactive, reprend
apres reactivation. Il sort en erreur si un son depasse 400 ms ou une crete de
0.08 — « discret ou rien » devient une contrainte executable.

### Le premier clic etait muet

Les navigateurs refusent d'ouvrir un contexte audio avant un geste. `play`
decouvrait l'absence de contexte, l'ouvrait, et laissait passer ce son-la —
exactement celui qui apprend a l'utilisateur que l'interface repond.

Le contexte s'arme maintenant au premier geste, quel qu'il soit, avec un
ecouteur qui se retire ensuite. Trouve en pilotant un vrai navigateur; invisible
a la lecture du code.

### Un decor qui ne raconte rien

Le fond holographique ne represente **aucune donnee**. C'est delibere: un decor
qui imiterait des chiffres serait un mensonge visuel, exactement ce que le
reste du projet s'interdit. Il suit l'etat de JARVIS — la piece s'eveille quand
il travaille — et c'est la seule chose qu'il dit, parce qu'elle est vraie.

La premiere version dessinait une grille en perspective, comme un sol qui
fuit. Sur un tableau de bord, sa ligne d'horizon traversait les cartes comme
une rayure. Une maille orthogonale, elle, se lit comme la structure d'un
panneau holographique et ne rentre en conflit avec aucune mise en page.

Trois contraintes: opacites sous 0.08 (si on la remarque en lisant, elle est
ratee), arret complet quand l'onglet passe en arriere-plan, et grille fixe
quand le systeme demande moins d'animations.

---

## 21. Connecter un logiciel qui n'a pas d'API

### Le constat, verifie et non suppose

La question posee etait: « peux-tu utiliser les acces de mon application pour
la connecter a JARVIS ? »

Recherche faite: **Maitre'D n'a pas d'API en libre-service.** Les integrations
passent par une entente avec Posera/PayFacto, et le logiciel tourne souvent
sur un serveur de back-office dans le commerce — donc derriere le reseau
local, sans point d'entree hebergé. Trois voies existaient, une seule tient.

**L'API officielle** demande une entente commerciale. C'est une conversation
d'affaires, pas du code, et elle ne depend pas de nous.

**Les identifiants de l'utilisateur** sont exclus. Ce n'est pas une limite
technique: se connecter a la place de quelqu'un avec son mot de passe est
exactement ce qu'un assistant ne doit jamais faire. Un identifiant confie a un
tiers reste confie a un tiers.

**Le rapport par courriel** fonctionne aujourd'hui, sans rien demander a
personne.

### Pourquoi le courriel est la bonne voie, pas un pis-aller

Presque tous ces logiciels savent envoyer un rapport a heure fixe. Ce rapport
arrive dans une boite a laquelle JARVIS a **deja** acces, en lecture seule,
avec une autorisation que l'utilisateur a lui-meme accordee et peut retirer.

Aucune entente, aucune cle, aucun secret nouveau. La surface d'attaque
n'augmente pas d'un pouce: on lit un courriel de plus.

### Ce qui rend l'import sur

**Aucune deduction.** JARVIS ne fouille pas la boite pour trouver ce qui
ressemble a un rapport. Sans regle nommant un expediteur, il ne lit rien — un
test le verifie en s'assurant qu'aucune requete Gmail n'est meme emise.

**Un courriel n'est importe qu'une fois.** La cle primaire est
`(message_id, org_id)`: c'est la base qui l'impose, pas une verification qu'on
pourrait oublier. La paire, et non le seul message, parce qu'un rapport envoye
a deux entreprises reste legitime.

**Un echec est reessayable.** Le courriel n'est retenu que si quelque chose en
est reellement sorti. Le marquer des qu'on l'a vu ferait perdre pour toujours
la journee ou Gmail a hoquete — un test tient cette distinction.

**Le contenu est une donnee, jamais une instruction.** Les pieces jointes
passent par le meme lecteur CSV que les fichiers deposes a la main, avec les
memes refus. Une piece jointe non tabulaire est signalee, pas interpretee: on
ne devine pas des chiffres dans un PDF.

**Une piece jointe demesuree est refusee** avant d'etre chargee en memoire. Un
rapport de caisse pese quelques dizaines de kilo-octets.

### Le dossier de la caisse, quand il est joignable

Meilleure voie que le courriel des qu'elle existe: aucun fournisseur a
solliciter, et les chiffres entrent des que la caisse ecrit son rapport.

La convention initiale — `dossier/<ORG_ID>/fichier.csv` — supposait que
l'utilisateur range les fichiers. Or la source la plus interessante est le
dossier d'export de la caisse elle-meme, dont l'organisation ne nous appartient
pas: Maitre'D ecrit `ventes_20260826.csv` a cote de `inventaire_*.csv` et d'un
sous-dossier d'archives. Exiger un rangement, c'est rendre la fonctionnalite
inutilisable la ou elle sert le plus.

`scan_mapped_folder` accepte donc **n'importe quel dossier** pour une
entreprise donnee, avec un motif optionnel (`ventes*.csv`) quand plusieurs
rapports cohabitent. Le chemin peut etre un UNC — il est conserve tel quel,
sans normalisation: `\\SERVEUR\Partage` est la forme que Windows donne a
l'utilisateur, et la transformer casserait l'acces sans que personne comprenne.

### La garantie qui compte: on ne touche a rien

Ce dossier appartient a un logiciel de production. JARVIS le **lit**; il ne
deplace, ne renomme et n'efface aucun fichier. Un test compare le contenu et
la date de modification de chaque fichier avant et apres un passage — la
faute serait invisible jusqu'au jour ou un rapport manquerait a quelqu'un
d'autre.

On ne descend pas dans les sous-dossiers non plus: une caisse archive souvent
des annees d'historique a cote, et les rejouer serait long autant que faux.

### Un partage deconnecte se voit

`last_error` est retenu par source et remonte a l'interface. Sans cela, JARVIS
afficherait les chiffres d'hier en laissant croire qu'ils sont d'aujourd'hui —
exactement le mensonge que tout le projet s'interdit. Le chemin est aussi
verifie **au moment de l'ajout**: une faute de frappe se decouvre la, pas des
heures plus tard devant un tableau de bord vide.

Et aucun mot de passe n'entre nulle part: c'est le systeme d'exploitation qui
detient l'acces au partage. JARVIS lit un chemin.

### Ce que ca ne remplace pas

Le courriel donne ce que le rapport contient, a la frequence ou il est envoye.
Ce n'est pas du temps reel, et ce n'est pas l'integralite de la base du
logiciel. C'est dit tel quel: la couverture voyage avec le chiffre, comme pour
toute autre source.

---

## 22. Ce que JARVIS ne fait pas encore

Enonce explicitement pour eviter toute illusion :

- pas de Google Tasks ;
- pas de lecture des feuilles de calcul locales (.xlsx) — Sheets passe par
  Drive, exporte en CSV ;
- pas de connecteur direct vers une caisse ou Stripe: les chiffres entrent
  par import CSV (les connecteurs ecriront les memes faits) ;
- **pas d'acces hors du reseau local**: JARVIS reste joignable depuis le meme
  Wi-Fi, pas depuis Internet. L'exposer demanderait un tunnel et du TLS ;
- pas d'empaquetage Tauri: le binaire ne peut etre ni compile ni verifie
  ailleurs que sous Windows ;
- pas de controle de l'ordinateur ;
- pas de recherche web ;
- pas de graphe de connaissances — il sera evalue en M4, seulement s'il apporte
  une valeur reelle par rapport a la recherche semantique + metadonnees.

Chacune de ces absences est annoncee, jamais simulee : JARVIS dit « Drive n'est
pas connecte » plutot que d'inventer un document.
