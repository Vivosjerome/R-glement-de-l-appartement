# Le Règlement

PWA de gestion des tâches ménagères pour deux personnes, avec notifications push
sur iPhone et Android. Pas de compte développeur Apple, pas de store, pas de
resignature tous les 7 jours.

## Mise en route

```bash
npm install
npm run setup          # génère les icônes + les clés VAPID
cp .env.example .env   # puis colle les clés VAPID affichées
npm start
```

L'app écoute sur `http://localhost:3000`. Le code d'accès par défaut est `1234`
(à changer dans `.env`), et les prénoms des deux occupants se règlent avec la
variable `USERS`.

## Il faut du HTTPS

C'est la seule contrainte vraiment incontournable : **les service workers et le
Web Push n'existent pas en HTTP**, sauf sur `localhost`. Une adresse de type
`http://192.168.1.x:3000` ne marchera pas, même sur le réseau local.

Le plus simple est un tunnel Cloudflare, gratuit et sans ouvrir de port sur la box :

```bash
cloudflared tunnel --url http://localhost:3000
```

Cela renvoie une URL `https://xxx.trycloudflare.com` utilisable immédiatement.
Pour une installation durable, crée un tunnel nommé avec ton propre domaine, sinon
l'URL change à chaque redémarrage et il faudra réinstaller la PWA.

## Installation sur les téléphones

**iPhone** — ouvrir l'URL dans Safari (pas Chrome), bouton Partager, « Sur l'écran
d'accueil ». Lancer l'app **depuis l'icône**, puis appuyer sur « Activer » dans le
bandeau. iOS refuse les notifications tant que l'app est ouverte dans un onglet
Safari classique.

**Android** — Chrome propose « Installer l'application ». Même principe ensuite.

## Connexion sans code

On n'entre jamais de mot de passe, et l'écran de connexion n'apparaît quasiment
jamais.

Depuis la machine qui héberge le serveur, `http://localhost:3000` entre directement :
une requête venant réellement de la loopback n'a rien à prouver. La vérification porte
sur l'adresse de la socket et sur l'absence d'en-têtes de transfert, pas sur `req.ip`,
qui provient de `X-Forwarded-For` et serait falsifiable depuis l'extérieur.

Pour les téléphones, le serveur génère au premier démarrage un lien d'invitation et
l'affiche dans la console :

```
http://localhost:3000/?k=e4e1b5c0...
```

Il suffit d'ouvrir ce lien sur un téléphone : l'app reconnaît l'appareil, se connecte
toute seule et retire aussitôt le secret de la barre d'adresse pour qu'il ne traîne ni
dans l'historique ni dans un partage d'écran. Le téléphone garde ensuite sa session
indéfiniment.

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

Les tâches vivent dans `server/tasks.js`. Toutes les règles n'en produisent pas une :
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
notification contenant l'image. Les photos restent consultables dans l'app, et un
appui sur la notification ouvre directement la bonne.

Le navigateur **redimensionne l'image avant l'envoi** (1600 px, JPEG qualité 0,75) :
une photo de téléphone de 4 Mo part à environ 200 Ko. L'envoi se fait en binaire brut,
sans multipart ni base64.

Les images sont stockées dans `data/photos/`, les 60 dernières sont conservées et les
plus anciennes supprimées du disque. Elles sont servies sans session, parce qu'une
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
tâche. L'heure se règle avec `RAPPEL_SOIR` dans `server/tasks.js`.

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
server/
  config.js      lecture du .env, utilisateurs
  tasks.js       les 11 règles traduites en tâches
  store.js       persistance JSON atomique (data/db.json)
  push.js        envoi Web Push, purge des abonnements morts
  engine.js      création des tâches, complétion, escalade des relances
  index.js       API REST + cron à la minute
public/          la PWA (aucune étape de build)
scripts/         génération des clés VAPID, des icônes, test du moteur
```

## Laisser tourner en permanence

Le serveur doit rester allumé pour envoyer les rappels. Sur un Raspberry Pi ou un
vieux PC sous Linux, un service systemd suffit. Sous Windows, `pm2` avec
`pm2 startup` fait le travail.
