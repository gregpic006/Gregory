# La voix de JARVIS

Trois niveaux, du gratuit au vraiment bon. Tu peux changer d'avis a tout
moment: une ligne dans `.env`, un redemarrage.

---

## Niveau 1 — Voix du systeme (actif par defaut, gratuit)

`JARVIS_TTS_PROVIDER=null`

Le navigateur lit avec les voix de Windows. JARVIS choisit automatiquement la
meilleure disponible, en privilegiant dans l'ordre: les voix **Natural**, les
voix **Online**, les timbres masculins, puis le francais canadien.

**Ameliorer sans rien payer.** Windows 11 propose des voix « naturelles »
nettement superieures aux anciennes, mais elles ne sont pas installees par
defaut:

> Parametres -> Heure et langue -> Voix -> **Ajouter des voix** ->
> chercher **Francais (Canada)** et **Francais (France)** -> installer

Redemarre le navigateur ensuite. Le nom de la voix retenue s'affiche dans la
barre du haut de l'interface: si tu vois apparaitre « Natural », c'est gagne.

Limite honnete: meme la meilleure voix Windows reste identifiable comme
synthetique. Pour la conversation quotidienne c'est acceptable; pour l'effet
JARVIS, non.

---

## Niveau 2 — OpenAI (~1 $ US par mois en usage normal)

`JARVIS_TTS_PROVIDER=openai` + `OPENAI_API_KEY=...`

Voix naturelles, latence correcte, facturation a l'usage. Les timbres
masculins graves: `onyx` (le plus pose), `ash`, `echo`.

```
JARVIS_TTS_PROVIDER=openai
JARVIS_TTS_OPENAI_MODEL=gpt-4o-mini-tts
JARVIS_TTS_OPENAI_VOICE=onyx
```

Bon compromis si tu as deja une cle OpenAI. Accent neutre, pas britannique.

---

## Niveau 3 — ElevenLabs (la voix JARVIS)

C'est ce qui donne le timbre du film: masculin, britannique, pose, articule.
Latence la plus basse du marche avec le modele `turbo`.

### Choisir la voix

1. Cree un compte sur **elevenlabs.io** (offre gratuite: ~10 000 caracteres
   par mois, suffisant pour essayer; ~5 $/mois ensuite)
2. **Voice Library** -> filtre **Male** + accent **British**
3. Cherche les descriptions du genre *calm*, *composed*, *narration*,
   *middle-aged*. Ecoute les extraits: c'est le seul moyen de choisir, et ca
   prend cinq minutes.
4. **Add to my voices**, puis dans **My Voices** copie le **Voice ID**

> Je ne recommande pas d'identifiant precis: le catalogue change, et le timbre
> qui te plaira ne se devine pas. Ecoute et choisis.

### Configurer

```
JARVIS_TTS_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=...
JARVIS_TTS_ELEVENLABS_VOICE_ID=le-voice-id-copie
JARVIS_TTS_ELEVENLABS_MODEL=eleven_turbo_v2_5
```

`eleven_turbo_v2_5` privilegie la latence, ce qui compte en conversation.
`eleven_multilingual_v2` rend un francais legerement plus soigne, au prix de
quelques centaines de millisecondes.

### Regler le timbre

C'est ici que se joue la difference entre un assistant et un narrateur:

```
JARVIS_TTS_STABILITY=0.55      # 0 = expressif et instable, 1 = monocorde
JARVIS_TTS_SIMILARITY=0.80     # fidelite au timbre d'origine
JARVIS_TTS_STYLE=0.10          # emphase dramatique: bas pour un assistant
JARVIS_TTS_SPEAKER_BOOST=true  # presence dans le grave
```

Pour un JARVIS plus froid et posé: `STABILITY=0.70`, `STYLE=0.05`.
Pour quelque chose de plus vivant: `STABILITY=0.40`, `STYLE=0.25`.

---

## Pourquoi ca parait fluide

La reponse n'est pas attendue en entier. Des qu'une phrase est complete dans le
flux, elle part a la synthese pendant que la suite s'ecrit. Ce qui compte n'est
pas le temps total, c'est le delai avant le premier son.

Et si tu reprends la parole, JARVIS se tait immediatement — la lecture est
coupee cote client, sans attendre le serveur.

---

## Verifier

```powershell
.\.venv\Scripts\python.exe -m jarvis_core.cli check-voice
```

La ligne **Voix** indique le moteur reellement actif et la taille de l'audio
genere. Si elle dit `voix du systeme (navigateur)`, c'est que
`JARVIS_TTS_PROVIDER` est reste a `null` — ou que l'API n'a pas ete redemarree.
