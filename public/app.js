const $ = (sel) => document.querySelector(sel);
const LS_TOKEN = "regles.token";
const LS_KEY = "regles.key";
const LS_USER = "regles.user";

let token = localStorage.getItem(LS_TOKEN);
let state = null;
let selectedUser = null;

// Les parametres sont lus une seule fois, avant d'etre effaces de l'URL.
const params = new URL(location.href).searchParams;
let pendingPhoto = params.get("photo");

// Secret du lien d'invitation : on le retire aussitot de la barre d'adresse
// pour qu'il ne finisse ni dans l'historique ni dans un partage d'ecran.
const inviteKey = (() => {
  const fromUrl = params.get("k");
  if (fromUrl) {
    localStorage.setItem(LS_KEY, fromUrl);
    history.replaceState(null, "", location.pathname);
    return fromUrl;
  }
  return localStorage.getItem(LS_KEY);
})();

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
const isStandalone =
  window.navigator.standalone === true ||
  window.matchMedia("(display-mode: standalone)").matches;

// Safari hors ecran d'accueil n'expose pas du tout l'API Notification.
const canNotify = "Notification" in window && "serviceWorker" in navigator;
const notifGranted = () => canNotify && Notification.permission === "granted";

// --------------------------------------------------------------------- api
async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (res.status === 401 && token) {
    localStorage.removeItem(LS_TOKEN);
    token = null;
    showLogin();
    throw new Error("Session expiree");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Erreur serveur");
  return data;
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2400);
}

// ------------------------------------------------------------------- login
const PLATFORM_LABEL = {
  android: { icon: "\u{1F4F1}", text: "Appareil Android reconnu" },
  ios: { icon: "\u{1F34E}", text: "iPhone reconnu" },
  windows: { icon: "\u{1F5A5}", text: "Ordinateur Windows reconnu" },
  "mac-or-ipad": { icon: "\u{1F4BB}", text: "Mac ou iPad reconnu" },
  unknown: { icon: "\u{2753}", text: "Appareil non reconnu" },
};

// Le serveur ne voit pas la difference entre un iPad et un Mac : iPadOS se
// declare comme un Mac de bureau, seul le tactile le distingue, et ca ne se
// teste que dans le navigateur.
function refinePlatform(platform) {
  if (platform === "mac-or-ipad") {
    return navigator.maxTouchPoints > 1 ? "ios" : "mac";
  }
  return platform;
}

function showManualChoice(users, preselected) {
  $("#recognized").classList.add("hidden");
  $("#not-me").classList.add("hidden");
  $("#manual-choice").classList.remove("hidden");
  selectedUser = preselected;

  const box = $("#user-choice");
  box.innerHTML = "";
  for (const user of users) {
    const btn = document.createElement("button");
    btn.textContent = user.name;
    btn.classList.toggle("selected", user.id === preselected);
    btn.onclick = () => {
      selectedUser = user.id;
      [...box.children].forEach((c) => c.classList.toggle("selected", c === btn));
    };
    box.appendChild(btn);
  }
}

async function doLogin(credentials, user) {
  const data = await api("/login", {
    method: "POST",
    body: JSON.stringify({ ...credentials, user }),
  });
  token = data.token;
  localStorage.setItem(LS_TOKEN, token);
  localStorage.setItem(LS_USER, data.user);
}

async function showLogin() {
  $("#app").classList.add("hidden");

  const info = await (await fetch("/api/public")).json();
  const platform = refinePlatform(info.platform);

  // Le serveur propose deja un nom ; on ne le recalcule que si son verdict
  // etait ambigu et que le tactile vient de trancher.
  let guess = info.suggested;
  if (!guess && platform !== info.platform) {
    guess = info.users.find((u) => u.platform === platform) || null;
  }

  // Si la plateforme ne tranche pas (un PC par exemple), on reprend le dernier
  // nom utilise sur cet appareil, et a defaut le premier occupant. On ne
  // bloque jamais sur un choix : l'identite se corrige dans les Reglages.
  const remembered = info.users.find((u) => u.id === localStorage.getItem(LS_USER));
  const resolved = guess || remembered || info.fallback;

  // Depuis la machine hote, ou avec le lien d'invitation, on entre sans rien
  // demander : l'ecran de connexion n'apparait meme pas. Le drapeau pose par
  // la deconnexion l'empeche de nous reconnecter aussitot.
  if ((info.local || inviteKey) && !sessionStorage.getItem("regles.noauto")) {
    try {
      await doLogin(inviteKey ? { key: inviteKey } : {}, resolved.id);
      return boot();
    } catch {
      localStorage.removeItem(LS_KEY);
    }
  }

  $("#login").classList.remove("hidden");
  selectedUser = resolved.id;

  if (guess) {
    const label = PLATFORM_LABEL[platform] || PLATFORM_LABEL.unknown;
    $("#recognized-icon").textContent = label.icon;
    $("#recognized-name").textContent = guess.name;
    $("#recognized-hint").textContent = label.text;
    $("#recognized").classList.remove("hidden");
    $("#manual-choice").classList.add("hidden");
    $("#not-me").classList.remove("hidden");
    $("#not-me").onclick = () => {
      const other = info.users.find((u) => u.id !== resolved.id) || resolved;
      showManualChoice(info.users, other.id);
    };
  } else {
    showManualChoice(info.users, resolved.id);
  }

  // Sans lien valide, il faut bien une preuve : le code de secours.
  if (!inviteKey) {
    $("#login-help").textContent =
      "Demande a l'autre de te renvoyer le lien d'invitation depuis ses Reglages.";
    $("#login-help").classList.remove("hidden");
    if (info.pinAvailable) {
      $("#use-pin").classList.remove("hidden");
      $("#use-pin").onclick = () => {
        $("#pin-block").classList.remove("hidden");
        $("#use-pin").classList.add("hidden");
        $("#pin").focus();
      };
    }
  }
}

$("#login-btn").onclick = async () => {
  const pin = $("#pin").value.trim();
  if (!selectedUser) return ($("#login-error").textContent = "Choisis qui tu es.");

  const credentials = inviteKey ? { key: inviteKey } : { pin };
  if (!inviteKey && !pin) {
    return ($("#login-error").textContent = "Il faut le lien d'invitation ou le code.");
  }

  try {
    await doLogin(credentials, selectedUser);
    $("#login-error").textContent = "";
    await boot();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
};

$("#pin").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#login-btn").click();
});

// ------------------------------------------------------------------- dates
function timeLabel(iso) {
  const date = new Date(iso);
  const today = new Date();
  const time = date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return `aujourd'hui ${time}`;
  return `${date.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

// ------------------------------------------------------------------ render
// Une tache du jour n'a pas d'heure limite et ne passe jamais "en retard" :
// on indique seulement depuis quand elle attend.
function dayLabel(task) {
  const days = Math.floor((startOfToday() - startOfDay(new Date(task.createdAt))) / 864e5);
  if (days <= 0) return "Aujourd'hui";
  if (days === 1) return "Depuis hier";
  return `Depuis ${days} jours`;
}

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const startOfToday = () => startOfDay(new Date());

function taskRow(task, actionable) {
  const el = document.createElement("div");
  const waiting = task.kind === "day" && new Date(task.createdAt).getTime() < startOfToday();
  el.className = `task ${colorOf(task.assignee)}${waiting ? " waiting" : ""}`;

  const when =
    task.kind === "day"
      ? dayLabel(task)
      : `Avant ${new Date(task.dueAt).toLocaleTimeString("fr-FR", {
          hour: "2-digit",
          minute: "2-digit",
        })}`;

  el.innerHTML = `
    <div class="task-badge">${task.emoji}</div>
    <div class="task-body">
      <div class="task-title">${task.label}</div>
      <div class="task-meta">${task.detail ? `${task.detail} &middot; ` : ""}${when}</div>
    </div>
  `;

  if (actionable) {
    const other = state.users.find((u) => u.id !== state.me);
    const btn = document.createElement("button");
    btn.className = "task-check";
    btn.setAttribute("aria-label", `Marquer ${task.label} comme fait`);
    btn.innerHTML = "&#10003;";
    btn.onclick = async () => {
      const suite =
        task.assign === "rotation" && task.days
          ? ` Ce sera son tour dans ${task.days} jours.`
          : "";
      const ok = await confirmSheet({
        emoji: task.emoji,
        title: `${task.label} : c'est fait ?`,
        text: `${other?.name} sera prevenue.${suite}`,
      });
      if (!ok) return;
      el.classList.add("completing");
      act(
        () => api("/complete", { method: "POST", body: JSON.stringify({ id: task.id }) }),
        "C'est note",
      );
    };
    el.appendChild(btn);
  }

  return el;
}

// Chaque occupant a sa couleur et son initiale, reprises partout : c'est ce
// qui permet de voir a qui appartient une ligne sans la lire.
function colorOf(assignee) {
  if (assignee === "both") return "duo";
  return `u${state.users.findIndex((u) => u.id === assignee)}`;
}

function avatar(assignee) {
  const el = document.createElement("div");
  el.className = `avatar ${colorOf(assignee)}`;
  el.textContent =
    assignee === "both"
      ? state.users.map((u) => u.name[0]).join("")
      : (state.users.find((u) => u.id === assignee)?.name || "?")[0];
  return el;
}

function groupHeader(assignee, title, count) {
  const el = document.createElement("div");
  el.className = "group";
  el.appendChild(avatar(assignee));
  el.insertAdjacentHTML(
    "beforeend",
    `<span class="name">${title}</span><span class="count">${count}</span>`,
  );
  return el;
}

function renderTasks() {
  const box = $("#open-tasks");
  box.innerHTML = "";

  if (!state.instances.length) {
    box.innerHTML = `<div class="empty">Rien a faire.<br>Profitez-en.</div>`;
    return;
  }

  const other = state.users.find((u) => u.id !== state.me);
  const mine = state.instances.filter((t) => t.assignee === state.me);
  const duo = state.instances.filter((t) => t.assignee === "both");
  const theirs = state.instances.filter((t) => t.assignee === other?.id);

  // Seul le responsable valide sa tache, sinon l'historique crediterait la
  // mauvaise personne. Celles de l'autre sont la pour information.
  const groups = [
    { assignee: state.me, title: "Toi", tasks: mine, actionable: true },
    { assignee: "both", title: "Ensemble", tasks: duo, actionable: true },
    { assignee: other?.id, title: other?.name, tasks: theirs, actionable: false },
  ];

  for (const group of groups) {
    if (!group.tasks.length) continue;
    box.appendChild(groupHeader(group.assignee, group.title, group.tasks.length));
    group.tasks.forEach((t) => box.appendChild(taskRow(t, group.actionable)));
  }
}

function confirmSheet({ emoji, title, text, ok = "Oui, c'est fait" }) {
  return new Promise((resolve) => {
    const sheet = $("#confirm");
    sheet.querySelector(".sheet-emoji").textContent = emoji;
    sheet.querySelector(".sheet-title").textContent = title;
    sheet.querySelector(".sheet-text").textContent = text;
    sheet.querySelector(".sheet-ok").textContent = ok;

    const close = (answer) => {
      sheet.classList.add("hidden");
      resolve(answer);
    };
    sheet.querySelector(".sheet-ok").onclick = () => close(true);
    sheet.querySelector(".sheet-cancel").onclick = () => close(false);
    sheet.onclick = (e) => {
      if (e.target === sheet) close(false);
    };
    sheet.classList.remove("hidden");
  });
}

function renderDeclarable() {
  const box = $("#declarable");
  box.innerHTML = "";
  if (!state.declarable.length) {
    box.innerHTML = `<div class="empty">Tout est deja dans la liste du jour.</div>`;
    return;
  }

  const other = state.users.find((u) => u.id !== state.me);
  for (const item of state.declarable) {
    const myTurn = item.turn === state.me || item.turn === "both";
    const btn = document.createElement("button");
    btn.disabled = !myTurn;

    // Grise chez celui qui vient de la faire, actif chez l'autre : c'est
    // comme ca que la tache se passe d'une personne a l'autre.
    btn.innerHTML = myTurn
      ? `<span>${item.emoji}</span>${item.label}
         <em>${other?.name} dans ${item.days} jours</em>`
      : `<span>${item.emoji}</span>${item.taskLabel}
         <em>Au tour de ${other?.name}${item.date ? ` &middot; ${dateLabel(item.date)}` : ""}</em>`;

    if (myTurn) {
      btn.onclick = async () => {
        const ok = await confirmSheet({
          emoji: item.emoji,
          title: item.label + " ?",
          text: `${other?.name} sera prevenue, et ce sera son tour dans ${item.days} jours.`,
        });
        if (!ok) return;
        act(
          () => api("/declare-done", { method: "POST", body: JSON.stringify({ defId: item.id }) }),
          `C'est note. A ${other?.name} dans ${item.days} jours.`,
        );
      };
    }
    box.appendChild(btn);
  }
}

function renderTriggers() {
  const box = $("#triggers");
  box.innerHTML = "";
  const other = state.users.find((u) => u.id !== state.me);

  for (const trigger of state.triggers) {
    const pour =
      trigger.assign === "together"
        ? "par l'un ou l'autre"
        : trigger.assign === "other"
          ? `par ${other?.name}`
          : "par toi";
    const quand = trigger.delayMinutes
      ? ` dans ${humanDelay(trigger.delayMinutes)}`
      : " tout de suite";

    const btn = document.createElement("button");
    btn.disabled = trigger.open;
    btn.innerHTML = `<span>${trigger.emoji}</span>${trigger.label}
      <em>${trigger.open ? "deja dans la liste" : `${trigger.taskLabel}${quand}`}</em>`;

    btn.onclick = async () => {
      const ok = await confirmSheet({
        emoji: trigger.emoji,
        title: `${trigger.label} ?`,
        text: `"${trigger.taskLabel}" sera a faire ${pour}${quand}.`,
        ok: "Oui, signaler",
      });
      if (!ok) return;
      act(
        () => api("/trigger", { method: "POST", body: JSON.stringify({ defId: trigger.id }) }),
        `${trigger.taskLabel} : c'est note`,
      );
    };
    box.appendChild(btn);
  }
}

function humanDelay(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const h = minutes / 60;
  return Number.isInteger(h) ? `${h} h` : `${Math.round(minutes / 6) / 10} h`;
}

function renderUpcoming() {
  const box = $("#upcoming");
  box.innerHTML = "";
  if (!state.upcoming.length) {
    box.innerHTML = `<div class="empty">Tout est deja dans la liste du jour.</div>`;
    return;
  }

  for (const item of state.upcoming) {
    const row = document.createElement("div");
    row.className = "next-row";
    row.innerHTML = `<span class="next-emoji">${item.emoji}</span>
      <span class="next-label">${item.label}</span>`;
    row.appendChild(avatar(item.assignee));
    row.insertAdjacentHTML("beforeend", `<span class="next-when">${dateLabel(item.date)}</span>`);
    box.appendChild(row);
  }
}

function dateLabel(iso) {
  const date = new Date(iso);
  const days = Math.round((startOfDay(date) - startOfToday()) / 864e5);
  const hour = `${date.getHours()}h`;
  // Pour aujourd'hui et demain l'heure compte : c'est ce qui explique
  // pourquoi la tache n'est pas encore dans la liste.
  if (days <= 0) return `aujourd'hui ${hour}`;
  if (days === 1) return `demain ${hour}`;
  if (days < 7) return date.toLocaleDateString("fr-FR", { weekday: "long" });
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

// ------------------------------------------------------------------ photos
/**
 * Reduit la photo avant l'envoi : une photo de telephone fait 4 Mo, on la
 * ramene autour de 200 Ko, ce qui suffit largement pour voir un tas de linge.
 */
async function shrink(file, max = 1600, quality = 0.75) {
  let source;
  let width;
  let height;

  try {
    source = await createImageBitmap(file, { imageOrientation: "from-image" });
    ({ width, height } = source);
  } catch {
    // Repli si createImageBitmap manque ou refuse le format.
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
    width = source.naturalWidth;
    height = source.naturalHeight;
  }

  const scale = Math.min(1, max / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();

  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

let pendingBlob = null;

$("#photo-btn").onclick = () => $("#photo-input").click();

$("#photo-input").onchange = async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ""; // permet de reprendre deux fois la meme photo
  if (!file) return;

  try {
    toast("Preparation de la photo...");
    pendingBlob = await shrink(file);
    $("#photo-preview").src = URL.createObjectURL(pendingBlob);
    $("#photo-note").value = "";
    $("#photo-sheet").classList.remove("hidden");
  } catch {
    toast("Impossible de lire cette image");
  }
};

const closePhotoSheet = () => {
  $("#photo-sheet").classList.add("hidden");
  pendingBlob = null;
};
$("#photo-cancel").onclick = closePhotoSheet;
$("#photo-sheet").onclick = (e) => {
  if (e.target === $("#photo-sheet")) closePhotoSheet();
};

$("#photo-send").onclick = async () => {
  if (!pendingBlob) return;
  const note = $("#photo-note").value.trim();
  const blob = pendingBlob;
  closePhotoSheet();

  try {
    // Envoi binaire direct : pas de multipart, pas de surcout base64.
    const res = await fetch(`/api/photo?note=${encodeURIComponent(note)}`, {
      method: "POST",
      headers: { "Content-Type": "image/jpeg", Authorization: `Bearer ${token}` },
      body: blob,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Envoi echoue");
    await refresh();
    toast("Photo envoyee");
  } catch (err) {
    toast(err.message);
  }
};

function renderPhotos() {
  const box = $("#photos");
  box.innerHTML = "";
  for (const photo of state.photos) {
    const cell = document.createElement("button");
    cell.className = "photo-cell";
    cell.innerHTML = `<img src="/photos/${photo.id}.jpg" alt="" loading="lazy">`;
    cell.appendChild(avatar(photo.from));
    cell.onclick = () => openViewer(photo);
    box.appendChild(cell);
  }
}

function openViewer(photo) {
  const who = state.users.find((u) => u.id === photo.from)?.name || photo.from;
  const viewer = $("#viewer");
  viewer.querySelector("img").src = `/photos/${photo.id}.jpg`;
  viewer.querySelector(".viewer-meta").textContent =
    `${photo.note ? `${photo.note} — ` : ""}${who}, ${timeLabel(photo.createdAt)}`;

  $("#viewer-delete").onclick = async () => {
    const ok = await confirmSheet({
      emoji: "\u{1F5D1}",
      title: "Supprimer cette photo ?",
      text: "Elle disparaitra pour vous deux.",
      ok: "Oui, supprimer",
    });
    if (!ok) return;
    viewer.classList.add("hidden");
    act(() => api(`/photo/${photo.id}`, { method: "DELETE" }), "Photo supprimee");
  };

  viewer.classList.remove("hidden");
}

// Seul un appui sur le fond ferme la visionneuse, pas sur ses boutons.
$("#viewer").onclick = (e) => {
  if (e.target === $("#viewer")) $("#viewer").classList.add("hidden");
};

function renderRules() {
  $("#reglement").innerHTML = state.reglement.map((r) => `<li>${r}</li>`).join("");
}

function renderStats() {
  const board = $("#scoreboard");
  const best = Math.max(...state.users.map((u) => state.stats[u.id]?.week ?? 0));
  board.innerHTML = state.users
    .map((u, i) => {
      const s = state.stats[u.id] || { week: 0, month: 0 };
      const leader = s.week === best && best > 0;
      return `<div class="score-card u${i}${leader ? " leader" : ""}">
          <div class="avatar u${i}">${u.name[0]}</div>
          <div class="name">${u.name}</div>
          <div class="big">${s.week}</div>
          <div class="sub">cette semaine &middot; ${s.month} ce mois</div>
        </div>`;
    })
    .join("");

  const hist = $("#history");
  if (!state.history.length) {
    hist.innerHTML = `<div class="empty">Rien encore.</div>`;
    return;
  }
  hist.innerHTML = state.history
    .map((h) => {
      const who = state.users.find((u) => u.id === h.doneBy)?.name || h.doneBy;
      return `<div class="task ${colorOf(h.doneBy)}">
          <div class="task-badge">${h.emoji}</div>
          <div class="task-body">
            <div class="task-title">${h.label}</div>
            <div class="task-meta"><span class="by">${who}</span> &middot; ${timeLabel(h.doneAt)}</div>
          </div>
        </div>`;
    })
    .join("");
}

function renderSettings() {
  $("#menage-day").value = String(state.settings.menageDay);
  $("#machine-minutes").value = state.settings.machineMinutes;
  $("#linge-sec").value = state.settings.lingeSecHours;
  renderDeviceBox();
  renderInviteBox();
  renderNotifBox();
}

function renderInviteBox() {
  const box = $("#invite-box");
  box.innerHTML = `Envoie ce lien a l'autre telephone : il ouvre l'app deja connectee,
    sans code a taper. A n'envoyer qu'a vous deux, il donne l'acces complet.`;

  const btn = document.createElement("button");
  btn.className = "btn";
  btn.textContent = "Partager le lien d'invitation";
  btn.onclick = async () => {
    try {
      const { url } = await api("/invite");
      // Sur mobile la feuille de partage native est le chemin le plus court
      // vers SMS ou WhatsApp ; ailleurs on se rabat sur le presse-papier.
      if (navigator.share) {
        await navigator.share({ title: "Le Reglement", url });
      } else {
        await navigator.clipboard.writeText(url);
        toast("Lien copie");
      }
    } catch (err) {
      if (err.name !== "AbortError") toast(err.message);
    }
  };
  box.appendChild(btn);
}

function renderDeviceBox() {
  const box = $("#device-box");
  const me = state.users.find((u) => u.id === state.me);
  const label = PLATFORM_LABEL[refinePlatform(state.device.platform)] || PLATFORM_LABEL.unknown;
  const other = state.users.find((u) => u.id !== state.me);

  box.innerHTML = `${label.icon} ${label.text}, attribue a <strong>${me?.name || "?"}</strong>.
    Les taches et les notifications arrivent sur ce telephone en son nom.`;

  const btn = document.createElement("button");
  btn.className = "btn ghost";
  btn.textContent = `Non, c'est le telephone de ${other?.name}`;
  btn.onclick = () =>
    act(async () => {
      await api("/switch-user", { method: "POST", body: JSON.stringify({ user: other.id }) });
      localStorage.setItem(LS_USER, other.id);
    }, `Appareil attribue a ${other.name}`);
  box.appendChild(btn);
}

function render() {
  const me = state.users.find((u) => u.id === state.me);
  $("#greeting").textContent = `Salut ${me?.name || ""}`;
  renderTasks();
  renderDeclarable();
  renderTriggers();
  renderPhotos();
  renderUpcoming();
  renderRules();
  renderStats();
  renderSettings();
  renderBanner();
}

async function act(fn, successMessage) {
  try {
    await fn();
    await refresh();
    toast(successMessage);
  } catch (err) {
    toast(err.message);
  }
}

async function refresh() {
  state = await api("/state");
  render();
}

// --------------------------------------------------------------- bandeau
function renderBanner() {
  const banner = $("#banner");

  // Sur iOS, le Web Push exige que l'app soit lancee depuis l'ecran d'accueil.
  if (isIOS && !isStandalone) {
    banner.innerHTML = `<strong>Ajoute l'app a ton ecran d'accueil</strong><br>
      Bouton Partager en bas de Safari, puis "Sur l'ecran d'accueil".
      Les notifications ne fonctionnent qu'une fois l'app installee.`;
    banner.classList.remove("hidden");
    return;
  }

  if (!notifGranted() || !state.subscribed) {
    banner.innerHTML = `<strong>Active les notifications</strong><br>
      Sans ca, tu ne recevras aucun rappel.`;
    const btn = document.createElement("button");
    btn.textContent = "Activer";
    btn.onclick = enablePush;
    banner.appendChild(btn);
    banner.classList.remove("hidden");
    return;
  }

  banner.classList.add("hidden");
}

function renderNotifBox() {
  const box = $("#notif-box");
  const granted = notifGranted() && state.subscribed;
  box.innerHTML = granted
    ? `<strong>Notifications actives</strong> sur cet appareil.`
    : `<strong>Notifications inactives.</strong> ${
        isIOS && !isStandalone
          ? "Installe d'abord l'app sur l'ecran d'accueil."
          : "Appuie sur le bouton ci-dessous."
      }`;

  const btn = document.createElement("button");
  btn.className = "btn";
  btn.textContent = granted ? "Envoyer une notification test" : "Activer les notifications";
  btn.onclick = granted
    ? () => act(() => api("/test-notification", { method: "POST" }), "Test envoye")
    : enablePush;
  box.appendChild(btn);
}

// ------------------------------------------------------------------- push
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function enablePush() {
  try {
    if (isIOS && !isStandalone) {
      return toast("Installe d'abord l'app sur l'ecran d'accueil");
    }
    if (!canNotify || !("PushManager" in window)) {
      return toast("Ce navigateur ne gere pas les notifications");
    }
    if (!state.vapidPublicKey) {
      return toast("Cles VAPID manquantes cote serveur");
    }

    // Doit etre declenche par un geste utilisateur, sinon iOS refuse.
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return toast("Permission refusee");

    const reg = await navigator.serviceWorker.ready;
    const subscription =
      (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(state.vapidPublicKey),
      }));

    await api("/subscribe", {
      method: "POST",
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });

    await refresh();
    toast("Notifications activees");
  } catch (err) {
    toast(err.message);
  }
}

// ------------------------------------------------------------------- tabs
document.querySelectorAll(".tabbar button").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".tabbar button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab").forEach((t) => t.classList.add("hidden"));
    $(`#tab-${btn.dataset.tab}`).classList.remove("hidden");
  };
});

$("#refresh").onclick = () => refresh().then(() => toast("A jour"));

$("#save-settings").onclick = () =>
  act(
    () =>
      api("/settings", {
        method: "POST",
        body: JSON.stringify({
          menageDay: Number($("#menage-day").value),
          machineMinutes: Number($("#machine-minutes").value),
          lingeSecHours: Number($("#linge-sec").value),
        }),
      }),
    "Reglages enregistres",
  );

$("#logout").onclick = () => {
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_KEY);
  sessionStorage.setItem("regles.noauto", "1");
  token = null;
  location.reload();
};

// ------------------------------------------------------------------- boot
async function boot() {
  if (!token) return showLogin();
  try {
    state = await api("/state");
  } catch {
    return showLogin();
  }
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  render();
  showPendingPhoto();
}

/** Ouverture directe de la photo quand on arrive depuis la notification. */
function showPendingPhoto() {
  if (!pendingPhoto) return;
  const photo = state.photos.find((p) => p.id === pendingPhoto);
  pendingPhoto = null;
  if (photo) openViewer(photo);
}

navigator.serviceWorker?.addEventListener("message", async (event) => {
  if (event.data?.type !== "navigate") return;
  const id = new URL(event.data.url, location.origin).searchParams.get("photo");
  if (!token) return;
  await refresh();
  if (id) {
    pendingPhoto = id;
    showPendingPhoto();
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("SW:", err));
}

// Le serveur cree des taches en continu : on resynchronise au retour sur l'app.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && token && state) refresh().catch(() => {});
});
setInterval(() => {
  if (!document.hidden && token && state) refresh().catch(() => {});
}, 60000);

boot();
