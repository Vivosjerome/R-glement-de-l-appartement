// Le Worker tourne en UTC : toutes les decisions horaires (une tache qui
// apparait a 19 h, le rappel de 20 h, le jour du menage) doivent etre prises
// dans le fuseau du logement. On passe par Intl, qui connait les changements
// d'heure, plutot que par un decalage fixe.

function parts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const out = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: +out.year,
    month: +out.month,
    day: +out.day,
    // Intl peut rendre "24" pour minuit selon la plateforme.
    hour: +out.hour % 24,
    minute: +out.minute,
    second: +out.second,
  };
}

/** Composantes locales, plus le jour de la semaine et une cle de journee. */
export function local(date, timeZone) {
  const p = parts(date, timeZone);
  const key = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  return { ...p, dayKey: key, weekday: new Date(`${key}T00:00:00Z`).getUTCDay() };
}

/** Decalage du fuseau a cet instant precis, en millisecondes. */
function offsetMs(date, timeZone) {
  const p = parts(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
}

/**
 * Instant UTC correspondant a une heure locale donnee.
 * On estime d'abord en UTC, puis on corrige du decalage reel a cette date,
 * ce qui reste juste de part et d'autre d'un changement d'heure.
 */
export function atLocalHour({ year, month, day }, hour, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, 0, 0);
  return new Date(guess - offsetMs(new Date(guess), timeZone));
}

/** Meme heure locale, N jours plus tard. */
export function addDaysAtHour(date, days, hour, timeZone) {
  const p = local(date, timeZone);
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return atLocalHour(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
    },
    hour,
    timeZone,
  );
}

/** Prochaine occurrence d'un jour de la semaine, a l'heure locale voulue. */
export function nextWeekday(from, weekday, hour, timeZone) {
  const p = local(from, timeZone);
  let delta = (weekday - p.weekday + 7) % 7;
  if (delta === 0 && p.hour >= hour) delta = 7;
  return addDaysAtHour(from, delta, hour, timeZone);
}
