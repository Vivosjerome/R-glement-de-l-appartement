# Le Règlement

PWA de gestion des tâches ménagères pour deux personnes, avec notifications push
sur iPhone et Android. Pas de compte développeur Apple, pas de store, pas de
resignature tous les 7 jours.

## Mise en ligne (gratuit, rien à laisser allumé)

Deux commandes, et l'app est en ligne avec son HTTPS et ses notifications :

```bash
npm install
npm run login      # ouvre le navigateur pour créer/connecter le compte Cloudflare
npm run deploy     # crée la base, le stockage, les clés, et met en ligne
```

`npm run deploy` est rejouable : il ne recrée jamais ce qui existe déjà, donc
c'est aussi la commande de mise à jour. À la fin, il affiche l'adresse
(`https://regles-appartement.<ton-compte>.workers.dev`) et le code d'accès.

Tout tient dans le niveau gratuit de Cloudflare : 100 000 requêtes par jour,
une base D1 de 5 Go, et un déclencheur qui réveille l'app chaque minute pour
créer les tâches du jour et envoyer les rappels. **Aucune carte bancaire n'est
demandée** — c'est pour ça que les photos sont stockées dans KV et non dans R2,
qui exige un moyen de paiement même sur son offre gratuite.

### Pourquoi pas GitHub Pages

GitHub Pages ne sert que des fichiers statiques : il n'exécute aucun code côté
serveur. Or trois choses en ont besoin, et aucune ne peut se faire dans le
navigateur :

- **Envoyer une notification à l'autre téléphone.** Il faut signer une requête
  vers Apple ou Google avec la clé VAPID privée. Publier cette clé dans le code
  de la page reviendrait à laisser n'importe qui notifier vos téléphones.
- **Partager l'état entre vous deux.** Le `localStorage` est propre à chaque
  navigateur : si tu valides la litière, rien n'arriverait jamais à Laurine.
- **Réveiller l'app quand elle est fermée.** Le rappel de 20 h doit partir même
  si personne n'a ouvert la page. C'est le rôle du déclencheur programmé.

Le dossier `public/` pourrait effectivement être hébergé sur Pages, mais il ne
serait alors qu'une coquille sans aucune des fonctions demandées.

## Développement en local

```bash
npm run db:local   # crée les tables dans la base locale (une seule fois)
npm run dev        # http://127.0.0.1:8788, base et stockage simulés sur disque
```

Les secrets locaux vont dans `.dev.vars` (ignoré par git). Pour déclencher le
cron à la main sans attendre : `curl "http://127.0.0.1:8788/__scheduled"`.

Le local utilise `preview_database_id` et `preview_id` dans `wrangler.toml`.
Ce n'est pas décoratif : sans eux, `wrangler dev` s'invente des identifiants,
les réécrit dans le fichier, et la base change sous les pieds.

### Tests

```bash
npm test             # fuseau, chiffrement Web Push, déclencheur, rotation
npm run test:worker  # parcours complets, avec `npm run dev` lancé à côté
npm run test:live    # vérifie l'app réellement en ligne (lecture seule)
```

`npm run test:worker` rejoue les vrais scénarios : connexion par lien, passage
de main sur la litière, blocage des clics en boucle, enchaînement machine →
étendre → rentrer, photo vue une fois puis effacée, déclenchement du cron.

`scripts/test-tick.js` mérite une mention : le déclencheur d'une minute est la
seule partie qui tourne sans que personne ne regarde, donc une erreur y
resterait invisible. Il l'exerce à des heures précises — samedi 15 h, 7 h du
matin, 19 h 30 — pour vérifier ce qui apparaît, ce qui attend, et pour qui.

## Version locale (optionnelle)

Un serveur Node équivalent subsiste dans `server/` pour tourner chez soi
(`npm start`, port 3000). Il demande alors du HTTPS, que `localhost` fournit
pour la machine hôte mais pas pour les téléphones : il faut un tunnel
(`cloudflared tunnel --url http://localhost:3000`) et laisser le PC allumé.
La version Cloudflare existe précisément pour éviter ça.

## Installation sur les téléphones

**iPhone** — ouvrir l'URL dans Safari (pas Chrome), bouton Partager, « Sur l'écran
d'accueil ». Lancer l'app **depuis l'icône**, puis appuyer sur « Activer » dans le
bandeau. iOS refuse les notifications tant que l'app est ouverte dans un onglet
Safari classique.

**Android** — Chrome propose « Installer l'application ». Même principe ensuite.

## Connexion sans code

On n'entre jamais de mot de passe, et l'écran de connexion n'apparaît quasiment
jamais.

Tout repose sur un **lien d'invitation** :

```
https://regles-appartement.xxx.workers.dev/?k=e4e1b5c0...
```

Il suffit de l'ouvrir sur un téléphone : l'app reconnaît l'appareil, se connecte
toute seule et retire aussitôt le secret de la barre d'adresse pour qu'il ne traîne ni
dans l'historique ni dans un partage d'écran. Le téléphone garde ensuite sa session
indéfiniment.

La toute première connexion, elle, se fait avec le code affiché par
`npm run deploy` ; ensuite le lien suffit pour le deuxième téléphone.

(En local, `http://localhost:3000` entre directement : une requête venant réellement
de la loopback n'a rien à prouver. La vérification porte sur l'adresse de la socket et
sur l'absence d'en-têtes de transfert, pas sur `req.ip`, qui provient de
`X-Forwarded-For` et serait falsifiable depuis l'extérieur. Hébergée sur Cloudflare,
l'app est toujours distante : ce raccourci n'existe plus.)

Une fois connecté, **Réglages → Ajouter un téléphone** permet de renvoyer ce lien par
SMS ou WhatsApp via la feuille de partage native. C'est comme ça qu'on installe l'app
sur le deuxième téléphone.

Le lien donne l'accès complet, donc il ne se partage qu'entre vous deux. Si jamais il
est perdu, le code défini par `APP_PIN` sert de secours via le lien « Entrer un code à
la place ». Mettre `APP_PIN=` vide désactive complètement cette porte de secours.

## Reconnaissance automatique de l'appareil

L'app devine qui l'ouvre à partir du système d'exploitation, configuré dans `USERS`
sous la forme `id:Prénom:plateforme`. L'écran de connexion affiche directement
« C'est bien toi, Laurine ? » sur l'iPhone et « C'est bien toi, Jérôme ? » sur
l'Android, il ne reste que le code à taper.

C'est une déduction, pas une identification : elle ne marche que parce que vous avez
chacun un OS différent. Si l'un ouvre l'app sur le téléphone de l'autre, la détection
se trompera. Le lien « Ce n'est pas moi » sur l'écran de connexion et le bouton dans
Réglages → Cet appareil permettent de corriger, et le choix est mémorisé
définitivement pour ce téléphone.

Sur un PC, où la plateforme ne désigne personne, l'app ne bloque pas pour autant :
elle reprend le dernier nom utilisé sur cet appareil, et à défaut le premier occupant
déclaré dans `USERS`. Mieux vaut entrer avec une identité corrigeable que rester
coincé devant un choix.

## Comment les règles sont traduites

Les tâches vivent dans `shared/tasks.js`, partagé par les deux versions.
Toutes les règles n'en produisent pas une :
celles qui se font dans la foulée, comme la vaisselle juste après avoir cuisiné ou
ne pas laisser traîner ses affaires, n'ont rien à suivre. Elles restent affichées
dans l'onglet Règles, sans polluer la liste du jour.

**Le rythme part de la dernière fois, pas du calendrier.** Quand quelqu'un valide la
litière, elle disparaît et réapparaît 2 jours plus tard **au nom de l'autre**. Même
principe pour l'aspirateur (3 jours, soit deux fois par semaine), la poussière
(7 jours) et la panière (3 jours). C'est la réalisation qui fait tourner le tour, donc
le rythme ne dérive jamais et personne ne peut sauter son tour.

Le ménage complet, frigo compris, est une seule tâche hebdomadaire sur le jour choisi
dans les réglages, à faire à deux. L'activité ensemble revient 7 jours après la
dernière.

Les boutons **« Je viens de le faire »** permettent de valider une tâche sans attendre
qu'elle apparaisse : faire la litière à 14 h alors qu'elle n'est prévue qu'à 19 h
relance immédiatement le compte à rebours au nom de l'autre. Ces boutons disparaissent
quand la tâche est déjà dans la liste du jour, puisque sa coche suffit.

Les boutons de **signalement** couvrent ce qu'aucun planning ne peut deviner. « Machine
lancée » programme « étendre le linge » pour la fin du cycle, et une fois étendu l'app
enchaîne sur « rentrer le linge » après le temps de séchage. « Poubelle devant la
porte » crée simplement une tâche commune : signaler la poubelle ne la refile à
personne, et la valider ne déclenche aucune rotation.

**Chaque action demande confirmation**, qu'il s'agisse d'une déclaration, d'un
signalement ou d'une simple coche. La fenêtre annonce précisément ce qui va se passer,
par exemple « Laurine sera prévenue, et ce sera son tour dans 2 jours ». Un appui à
côté annule.

## Partage de photos

Le bouton « Prendre ou choisir une photo » ouvre l'appareil photo ou la galerie.
Un aperçu s'affiche, avec un champ facultatif pour un mot, puis l'autre reçoit une
notification contenant l'image. Un appui sur la notification ouvre directement
la bonne photo.

**Une photo ne se voit qu'une fois.** Dans la grille, celle qu'on a reçue n'affiche
aucune miniature, juste une vignette « Voir une fois » : la montrer là réduirait
l'intérêt de l'ouvrir. Dès que le destinataire referme la visionneuse, l'image est
effacée du stockage, pour tous les deux. Quitter l'app sans refermer compte aussi
comme vu — la requête part avec `keepalive`, qui la laisse aboutir après le départ
de la page, et qui contrairement à `sendBeacon` accepte notre en-tête
d'authentification.

L'expéditeur, lui, peut rouvrir son propre envoi autant qu'il veut sans le
consommer : sinon il effacerait son message en vérifiant ce qu'il a envoyé. Tant
que sa photo est encore là, marquée « Pas encore vue », c'est qu'elle ne l'a pas
été — ça tient lieu d'accusé de réception.

Le navigateur **redimensionne l'image avant l'envoi** (1600 px, JPEG qualité 0,75) :
une photo de téléphone de 4 Mo part à environ 200 Ko. L'envoi se fait en binaire brut,
sans multipart ni base64.

Les images sont stockées dans le KV Cloudflare (sur disque en local), les 60 dernières
sont conservées et les plus anciennes effacées. Elles sont servies sans session, parce qu'une
notification charge l'image sans nos en-têtes d'authentification : c'est le nom de
fichier, un UUID, qui fait office de clé.

À savoir : **iOS n'affiche pas les images dans les notifications web.** Laurine verra
le texte « Jérôme t'envoie une photo » et devra appuyer pour voir l'image, qui s'ouvre
alors directement. Sur Android, l'image apparaît dans la notification déroulée.

## Pas de notion de retard

Une tâche du jour est à faire le jour même, point. Pas de compte à rebours, pas de
rouge, pas de « en retard de 3 h ». L'app indique seulement « Aujourd'hui », puis
« Depuis hier » si ça traîne.

Les rappels passent par le téléphone : une notification quand la tâche apparaît, puis
**un seul rappel groupé à 20 h** listant ce qui reste, plutôt qu'une notification par
tâche. L'heure se règle avec `RAPPEL_SOIR` dans `shared/tasks.js`.

Toutes ces heures sont comprises dans le fuseau de l'appartement, réglé par la
variable `TIMEZONE` du `wrangler.toml`. C'est nécessaire parce que Cloudflare
exécute le code en UTC : sans ça, « 19 h » tomberait à 20 h l'été. Les changements
d'heure sont gérés, y compris pour une échéance à deux jours qui enjambe la nuit
du passage à l'heure d'hiver.

Une tâche ne peut être validée que par la personne à qui elle incombe, sinon
l'historique créditerait la mauvaise personne. Celles de l'autre restent affichées
sous son nom, mais sans bouton : c'est de l'information, pas une action.

## Lecture en un coup d'œil

Chaque occupant a **sa couleur et son initiale**, reprises partout : dans l'en-tête de
groupe, sur le liseré gauche de chaque tâche, dans « Ensuite », dans l'historique et
sur les scores. On identifie le propriétaire d'une ligne sans la lire.

La liste du jour est découpée en trois blocs — **Toi**, **Ensemble**, puis le prénom
de l'autre — chacun avec son compteur. Seuls les deux premiers ont des boutons de
validation.

La section **Ensuite** est volontairement différente : pas de carte, pas de bouton,
juste des lignes compactes avec la date et l'avatar du prochain responsable. Elle
annonce ce qui arrivera tout seul, ce n'est pas une liste d'actions.

## Ce que le Web Push ne sait pas faire sur iPhone

À savoir avant de compter dessus : iOS joue **le son de notification par défaut** et
ne permet pas d'en choisir un autre depuis le web, ni de passer le mode silencieux.
Si tu veux une alerte sonore insistante pour les cas critiques, il faudra la router
vers une app dédiée type Pushover plutôt que vers la PWA.

## Structure

```
shared/tasks.js  les 11 règles traduites en tâches (commun aux deux versions)
worker/          la version Cloudflare, celle qui est en ligne
  index.js         routes HTTP (Hono) + déclencheur programmé
  engine.js        création des tâches, complétion, rotation, rappels
  store.js         accès à la base D1
  webpush.js       VAPID et chiffrement, écrits avec WebCrypto
  time.js          raisonnement horaire dans le fuseau de l'appartement
  push.js          envoi, purge des abonnements morts
  config.js        lecture des variables d'environnement
server/          la version Node locale, même logique sur Express
public/          la PWA (aucune étape de build)
scripts/         installation Cloudflare, clés VAPID, icônes, tests
schema.sql       les tables D1
wrangler.toml    bindings, variables, déclencheur cron
```

`worker/webpush.js` réimplémente la bibliothèque `web-push` avec WebCrypto,
parce que celle-ci dépend du module `crypto` de Node, absent des Workers :
signature VAPID en ES256, puis chiffrement `aes128gcm` du corps du message.
`scripts/test-webpush.js` joue le rôle du navigateur et déchiffre le résultat
pour vérifier que l'implémentation est conforme.
