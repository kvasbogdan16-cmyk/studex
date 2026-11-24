// Чат відмов: розбір повідомлень, бот, періоди, звіти й кнопки для /report.
// Файл із «_» на початку Vercel не публікує як окрему функцію.

const crypto = require("crypto");
const { env, rpc } = require("./_telegram");

const TZ = "Europe/Kyiv";
const LVIV = "Львів";
const ALL_CITIES = "*";
const MAX_MESSAGE = 4000; // ліміт Telegram — 4096 символів, лишаємо запас
const MAX_CALLBACK = 64; // ліміт Telegram на callback_data, у байтах
const RECENT_DAYS = 90; // з яких днів брати міста для кнопок
const CITY_BUTTONS = 8;

// ---------- Бот ----------

async function tg(method, payload) {
  const token = env("REFUSALS_BOT_TOKEN");
  if (!token) throw new Error("REFUSALS_BOT_TOKEN не задано у Vercel");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

// Секрет вебхука: Telegram надсилає його в заголовку X-Telegram-Bot-Api-Secret-Token.
// Виводимо з TG_SERVER_SECRET, щоб не заводити ще одну змінну.
function webhookSecret() {
  const base = env("TG_SERVER_SECRET");
  if (!base) return "";
  return crypto.createHmac("sha256", base).update("refusals-webhook").digest("hex");
}

// ---------- Розбір повідомлення ----------

const FIELDS = {
  city: ["місто", "город", "city"],
  reason: ["причина", "reason"],
  person: ["ім'я", "имя", "піб", "кандидат", "клієнт", "хто"],
  phone: ["телефон", "тел", "тел.", "номер", "номер телефону", "моб", "мобільний", "phone"],
  comment: ["коментар", "комментарий", "примітка", "деталі"],
};

const CITY_ALIASES = {
  "львів": LVIV, "львов": LVIV, "lviv": LVIV, "lvov": LVIV, "lwów": LVIV,
  "київ": "Київ", "киев": "Київ", "kyiv": "Київ", "kiev": "Київ",
  "харків": "Харків", "харьков": "Харків", "kharkiv": "Харків",
  "одеса": "Одеса", "одесса": "Одеса", "odesa": "Одеса", "odessa": "Одеса",
  "дніпро": "Дніпро", "днепр": "Дніпро", "dnipro": "Дніпро",
};

const LIMITS = { city: 60, reason: 200, person: 100, phone: 30, comment: 1000 };

function unifyApostrophes(s) {
  return s.replace(/[ʼ’`´]/g, "'");
}

// Ключ для порівняння назв без урахування регістру й виду апострофа
function keyOf(s) {
  return unifyApostrophes(String(s || "").toLowerCase());
}

function fieldOf(label) {
  const key = keyOf(label.trim());
  for (const [field, names] of Object.entries(FIELDS)) {
    if (names.includes(key)) return field;
  }
  return null;
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function normalizeCity(raw) {
  const s = raw
    .replace(/^#/, "")
    .replace(/_/g, " ")
    .trim()
    .replace(/^(?:місто|город|м\.|г\.|м\s)\s*/iu, "")
    .replace(/[.,;:!]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  const key = keyOf(s);
  if (CITY_ALIASES[key]) return CITY_ALIASES[key];
  // «івано-франківськ» → «Івано-Франківськ»
  return s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, p, c) => p + c.toUpperCase()).slice(0, LIMITS.city);
}

function normalizeText(raw, limit) {
  return raw.replace(/\s+/g, " ").trim().slice(0, limit);
}

function normalizeReason(raw) {
  return capitalize(normalizeText(raw, LIMITS.reason).replace(/[.;]+$/u, ""));
}

// «067 123 45 67» → «+380671234567». Від 10 до 13 цифр, як у формі заявки на сайті.
function normalizePhone(raw) {
  const s = normalizeText(raw, LIMITS.phone);
  if (!s) return { phone: "", valid: true };
  const digits = s.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 13) return { phone: s, valid: false };
  if (digits.length === 10 && digits.startsWith("0")) return { phone: "+38" + digits, valid: true };
  if (digits.length === 12 && digits.startsWith("380")) return { phone: "+" + digits, valid: true };
  return { phone: (s.startsWith("+") ? "+" : "") + digits, valid: true };
}

// Повертає { isAttempt, city, reason, person, phone, comment, missing: [], invalid: [] }.
// Відмовою вважається повідомлення з полем («Місто:», «Причина:»…) або хештегом #відмова.
function parseRefusal(text) {
  const out = { isAttempt: false, city: "", reason: "", person: "", phone: "", comment: "", missing: [], invalid: [] };
  if (typeof text !== "string" || !text.trim()) return out;

  const extra = []; // рядки без мітки після «Коментар:» продовжують коментар
  let lastField = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*[-•*]?\s*([^:：\n]{2,20}?)\s*[:：]\s*(.*)$/u);
    const field = m && fieldOf(m[1]);
    if (field) {
      out.isAttempt = true;
      lastField = field;
      if (!out[field]) out[field] = m[2];
    } else if (lastField === "comment" && line.trim()) {
      extra.push(line.trim());
    }
  }
  if (extra.length) out.comment = [out.comment, ...extra].filter(Boolean).join(" ");

  const tags = [...text.matchAll(/#([\p{L}\d_'ʼ’-]+)/gu)].map((t) => t[1]);
  const isTagged = tags.some((t) => ["відмова", "відмови", "отказ"].includes(t.toLowerCase()));
  if (isTagged) out.isAttempt = true;
  if (!out.city) {
    const cityTag = tags.find((t) => !["відмова", "відмови", "отказ"].includes(t.toLowerCase()) && /\p{L}/u.test(t));
    if (cityTag) out.city = cityTag;
  }

  out.city = normalizeCity(out.city);
  out.reason = normalizeReason(out.reason);
  out.person = normalizeText(out.person, LIMITS.person);
  out.comment = normalizeText(out.comment, LIMITS.comment);
  const phone = normalizePhone(out.phone);
  out.phone = phone.phone;

  if (!out.city) out.missing.push("місто");
  if (!out.reason) out.missing.push("причину");
  if (!phone.valid) out.invalid.push("номер телефону (має бути 10–13 цифр, напр. +380671234567)");
  return out;
}

const TEMPLATE =
  "Місто: Львів\n" +
  "Причина: не влаштувала ціна\n" +
  "Ім'я: Олена Коваль\n" +
  "Телефон: +380671234567\n" +
  "Коментар: знайшла дешевше";

function helpText() {
  return (
    "Я збираю відмови з цього чату й надсилаю звіти: щопонеділка — за минулий тиждень, " +
    "1-го числа — за минулий місяць (загальний і окремий детальний по Львову).\n\n" +
    "Напиши відмову окремим повідомленням за шаблоном:\n\n" +
    `<code>${escapeHtml(TEMPLATE)}</code>\n\n` +
    "Обов'язкові лише «Місто» і «Причина». Місто можна вказати й хештегом: #Львів.\n" +
    "Помилився — просто відредагуй повідомлення. Щоб прибрати відмову зі звітів, " +
    "відповідай на неї командою /undo.\n\n" +
    "Звіт будь-коли: /report — обери місто й період кнопками. Або одразу: /report Київ"
  );
}

// ---------- Дати й періоди (за київським часом) ----------

const MONTHS = ["січень", "лютий", "березень", "квітень", "травень", "червень",
  "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];
const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];

const pad = (n) => String(n).padStart(2, "0");

function kyivParts(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get("year"), m: get("month"), d: get("day"), hh: get("hour"), mm: get("minute") };
}

// Момент, коли в Києві настає 00:00 цього дня
function kyivMidnight({ y, m, d }) {
  const target = Date.UTC(y, m - 1, d);
  let t = target;
  for (let i = 0; i < 3; i++) {
    const p = kyivParts(new Date(t));
    const diff = target - Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    if (!diff) break;
    t += diff;
  }
  return new Date(t);
}

function addDays({ y, m, d }, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

// Пн = 0 … Нд = 6
function weekdayIndex({ y, m, d }) {
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function mondayOf(day) {
  return addDays(day, -weekdayIndex(day));
}

function previousMonth({ y, m }) {
  return m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
}

function nextMonth({ y, m }) {
  return m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
}

function parseMonth(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(value || "");
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  return m >= 1 && m <= 12 ? { y, m } : null;
}

function parseDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!match) return null;
  const day = { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
  const check = addDays(day, 0);
  return check.y === day.y && check.m === day.m && check.d === day.d ? day : null;
}

function monthName({ y, m }) {
  return `${MONTHS[m - 1]} ${y}`;
}

const fmtDay = ({ d, m }) => `${pad(d)}.${pad(m)}`;
const sameDay = (a, b) => a.y === b.y && a.m === b.m && a.d === b.d;

// Період звіту: [from, to) і попередній період для порівняння.
// kind — "week" (з понеділка) або "month". Якщо now припадає на період, він «поки що»:
// рахуємо до now, а порівнюємо з тими ж днями попереднього періоду.
function makePeriod(kind, startDay, now) {
  const start = kind === "month" ? { y: startDay.y, m: startDay.m, d: 1 } : mondayOf(startDay);
  const endDay = kind === "month" ? { ...nextMonth(start), d: 1 } : addDays(start, 7);
  const prevStart = kind === "month" ? { ...previousMonth(start), d: 1 } : addDays(start, -7);

  const from = kyivMidnight(start);
  const fullTo = kyivMidnight(endDay);
  const partial = Boolean(now) && now > from && now < fullTo;
  const to = partial ? now : fullTo;

  const prevFrom = kyivMidnight(prevStart);
  const prevTo = partial ? new Date(Math.min(prevFrom.getTime() + (to - from), from.getTime())) : from;

  const lastDay = partial ? kyivParts(new Date(to.getTime() - 1)) : addDays(endDay, -1);
  const asOf = partial ? ` — станом на ${fmtDay(lastDay)}` : "";

  let title, prevShort;
  if (kind === "month") {
    title = monthName(start) + asOf;
    prevShort = MONTHS[prevStart.m - 1];
  } else {
    title = `тиждень ${fmtDay(start)}–${fmtDay(addDays(endDay, -1))}${asOf}`;
    prevShort = "попер. тиждень";
  }
  const prevLabel = kind === "month"
    ? `${MONTHS[prevStart.m - 1]}${partial ? " за ті ж дні" : ""}`
    : `попередній тиждень${partial ? " за ті ж дні" : ""}`;

  return { kind, start, lastDay: { y: lastDay.y, m: lastDay.m, d: lastDay.d }, from, to, prevFrom, prevTo, partial, title, prevLabel, prevShort };
}

const PERIODS = {
  tw: "Цей тиждень",
  tm: "Цей місяць",
  lw: "Минулий тиждень",
  lm: "Минулий місяць",
};

function periodFor(code, now = new Date()) {
  const p = kyivParts(now);
  const today = { y: p.y, m: p.m, d: p.d };
  switch (code) {
    case "tw": return makePeriod("week", today, now);
    case "lw": return makePeriod("week", addDays(mondayOf(today), -7));
    case "tm": return makePeriod("month", today, now);
    case "lm": return makePeriod("month", { ...previousMonth(today), d: 1 });
    default: return null;
  }
}

// ---------- Дані ----------

async function fetchRange(from, to) {
  return (await rpc("refusals_range", { p_from: from.toISOString(), p_to: to.toISOString() })) || [];
}

async function fetchPeriod(period) {
  const [rows, prevRows] = await Promise.all([fetchRange(period.from, period.to), fetchRange(period.prevFrom, period.prevTo)]);
  return { rows, prevRows };
}

// Міста з відмовами за останні RECENT_DAYS днів — для кнопок, найчастіші першими
async function recentCities(now = new Date()) {
  const p = kyivParts(now);
  const rows = await fetchRange(kyivMidnight(addDays({ y: p.y, m: p.m, d: p.d }, -RECENT_DAYS)), now);
  return sorted(countBy(rows, (r) => r.city)).map(([, item]) => item);
}

// ---------- Звіти ----------

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Групує рядки за ключем без урахування регістру; підпис — перше написання
function countBy(rows, valueOf) {
  const map = new Map();
  for (const row of rows) {
    const label = valueOf(row) || "—";
    const key = keyOf(label);
    const item = map.get(key) || { label, count: 0 };
    item.count += 1;
    map.set(key, item);
  }
  return map;
}

function sorted(map) {
  return [...map.entries()].sort((a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label, "uk"));
}

function percent(part, total) {
  return total ? Math.round((part / total) * 100) : 0;
}

function delta(cur, prev) {
  const diff = cur - prev;
  if (diff === 0) return "без змін";
  const sign = diff > 0 ? "+" : "−";
  const pct = prev ? ` (${sign}${Math.abs(Math.round((diff / prev) * 100))}%)` : "";
  return `${sign}${Math.abs(diff)}${pct}`;
}

function totalLine(cur, prev, period) {
  return `Усього: <b>${cur}</b> · ${period.prevLabel}: ${prev} → ${delta(cur, prev)}`;
}

function messageLink(row) {
  const id = String(row.chat_id);
  // Посилання на повідомлення працюють лише в супергрупах (ID починається з -100)
  return id.startsWith("-100") ? `https://t.me/c/${id.slice(4)}/${row.message_id}` : "";
}

function isCity(row, city) {
  return keyOf(row.city) === keyOf(city);
}

function buildGeneralReport(rows, prevRows, period) {
  const lines = [`📊 <b>Відмови — ${period.title}</b>`, "", totalLine(rows.length, prevRows.length, period)];
  if (!rows.length) {
    lines.push("", "За цей період відмов у чаті не було.");
    return lines;
  }

  const cities = countBy(rows, (r) => r.city);
  const prevCities = countBy(prevRows, (r) => r.city);
  for (const [key, item] of prevCities) {
    if (!cities.has(key)) cities.set(key, { label: item.label, count: 0 });
  }
  lines.push("", "<b>По містах</b>");
  for (const [key, item] of sorted(cities)) {
    const prev = prevCities.get(key)?.count || 0;
    lines.push(`• ${escapeHtml(item.label)} — ${item.count} · ${period.prevShort}: ${prev} → ${delta(item.count, prev)}`);
  }

  const reasons = sorted(countBy(rows, (r) => r.reason));
  const TOP = 10;
  lines.push("", "<b>Причини</b>");
  reasons.slice(0, TOP).forEach(([, item], i) => {
    lines.push(`${i + 1}. ${escapeHtml(item.label)} — ${item.count} (${percent(item.count, rows.length)}%)`);
  });
  const rest = reasons.slice(TOP).reduce((sum, [, item]) => sum + item.count, 0);
  if (rest) lines.push(`Інші причини (${reasons.length - TOP}) — ${rest} (${percent(rest, rows.length)}%)`);

  return lines;
}

// Для тижня — по днях, для місяця — по тижнях (1–7, 8–14, …)
function breakdownLines(rows, period) {
  const counts = new Map();
  for (const row of rows) {
    const t = kyivParts(new Date(row.created_at));
    const key = `${t.y}-${t.m}-${t.d}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const countOf = (day) => counts.get(`${day.y}-${day.m}-${day.d}`) || 0;

  if (period.kind === "week") {
    const lines = ["<b>По днях</b>"];
    for (let i = 0; i < 7; i++) {
      const day = addDays(period.start, i);
      lines.push(`${WEEKDAYS[i]} ${fmtDay(day)} — ${countOf(day)}`);
      if (sameDay(day, period.lastDay)) break;
    }
    return lines;
  }

  const lines = ["<b>По тижнях</b>"];
  const { y, m } = period.start;
  const last = period.lastDay.d;
  for (let first = 1; first <= last; first += 7) {
    const end = Math.min(first + 6, last);
    let count = 0;
    for (let d = first; d <= end; d++) count += countOf({ y, m, d });
    lines.push(`${pad(first)}.${pad(m)}–${pad(end)}.${pad(m)} — ${count}`);
  }
  return lines;
}

function buildCityReport(city, allRows, allPrevRows, period) {
  const rows = allRows.filter((r) => isCity(r, city));
  const prevRows = allPrevRows.filter((r) => isCity(r, city));
  const lines = [`📍 <b>${escapeHtml(city)} — детальний звіт, ${period.title}</b>`, "", totalLine(rows.length, prevRows.length, period)];
  if (!rows.length) {
    lines.push("", `За цей період відмов по місту ${escapeHtml(city)} не було.`);
    return lines;
  }
  lines.push(`Частка від усіх відмов: ${percent(rows.length, allRows.length)}%`);

  // Причини з порівнянням із попереднім періодом
  const prevReasons = countBy(prevRows, (r) => r.reason);
  lines.push("", "<b>Причини</b>");
  sorted(countBy(rows, (r) => r.reason)).forEach(([key, item], i) => {
    const prev = prevReasons.get(key)?.count || 0;
    lines.push(`${i + 1}. ${escapeHtml(item.label)} — ${item.count} (${percent(item.count, rows.length)}%) · ${period.prevShort}: ${prev}`);
  });

  lines.push("", ...breakdownLines(rows, period));

  lines.push("", "<b>Хто вносив</b>");
  for (const [, item] of sorted(countBy(rows, (r) => r.author_name))) {
    lines.push(`• ${escapeHtml(item.label)} — ${item.count}`);
  }

  lines.push("", "<b>Усі відмови</b>");
  rows.forEach((row, i) => {
    const t = kyivParts(new Date(row.created_at));
    const when = `${pad(t.d)}.${pad(t.m)} ${pad(t.hh)}:${pad(t.mm)}`;
    const link = messageLink(row);
    const date = link ? `<a href="${link}">${when}</a>` : when;
    const client = [row.person, row.phone].filter(Boolean).map(escapeHtml).join(", ");
    const who = client ? ` · ${client}` : "";
    const details = [row.comment && `<i>${escapeHtml(row.comment)}</i>`, row.author_name && `вніс(-ла): ${escapeHtml(row.author_name)}`]
      .filter(Boolean)
      .join(" · ");
    lines.push(`${i + 1}. ${date}${who} — ${escapeHtml(row.reason)}${details ? `\n    ${details}` : ""}`);
  });

  return lines;
}

// Обрізає задовгий рядок, не ламаючи HTML для Telegram: прибирає теги (форматування
// лише цього рядка втрачається) і не розрізає сутність &amp; / &lt; / &gt;.
// Інакше Telegram відхиляє все повідомлення («can't parse entities»).
function truncateHtml(line, max) {
  const text = line.replace(/<[^>]*>/g, "");
  if (text.length <= max) return text;
  let cut = max - 1;
  const amp = text.lastIndexOf("&", cut - 1);
  if (amp !== -1 && text.indexOf(";", amp) >= cut) cut = amp;
  return text.slice(0, cut) + "…";
}

// Ділить рядки на повідомлення до ліміту Telegram, не розриваючи рядок
function toMessages(lines) {
  const messages = [];
  let current = "";
  for (const raw of lines) {
    const line = raw.length > MAX_MESSAGE ? truncateHtml(raw, MAX_MESSAGE) : raw;
    if (current && current.length + 1 + line.length > MAX_MESSAGE) {
      messages.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current.trim()) messages.push(current);
  return messages;
}

// Повідомлення звіту: усі міста — загальний, конкретне місто — детальний
function reportMessages(city, period, rows, prevRows) {
  const lines = city === ALL_CITIES
    ? buildGeneralReport(rows, prevRows, period)
    : buildCityReport(city, rows, prevRows, period);
  return toMessages(lines);
}

// Автоматичний звіт (щотижня й щомісяця): загальний + детальний по Львову
function scheduledMessages(period, rows, prevRows) {
  return [...reportMessages(ALL_CITIES, period, rows, prevRows), ...reportMessages(LVIV, period, rows, prevRows)];
}

// ---------- Кнопки /report ----------
// callback_data: «rc|<місто>» — обрали місто, «rp|<період>|<місто>» — обрали період, «rb» — назад до міст.

const fits = (data) => Buffer.byteLength(data, "utf8") <= MAX_CALLBACK;

// Місто вміщається в кнопку періоду (найдовший варіант callback_data)
function cityFitsButtons(city) {
  return fits(`rp|tw|${city}`);
}

function cityTitle(city) {
  return city === ALL_CITIES ? "усі міста" : city;
}

function cityKeyboard(cities) {
  const rows = [[{ text: "🌍 Усі міста", callback_data: `rc|${ALL_CITIES}` }]];
  const buttons = cities
    .filter((c) => c.label !== "—" && cityFitsButtons(c.label))
    .slice(0, CITY_BUTTONS)
    .map((c) => ({ text: `${c.label} (${c.count})`, callback_data: `rc|${c.label}` }));
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return { inline_keyboard: rows };
}

function cityPromptText(cities) {
  const hint = cities.length
    ? `Міста з відмовами за останні ${RECENT_DAYS} днів. Іншого міста немає в списку — напиши /report Назва.`
    : `За останні ${RECENT_DAYS} днів відмов не було. Будь-яке місто можна запитати так: /report Назва.`;
  return `📊 <b>Звіт по відмовах</b>\nОбери місто.\n\n<i>${hint}</i>`;
}

function periodKeyboard(city) {
  const button = (code) => ({ text: PERIODS[code], callback_data: `rp|${code}|${city}` });
  return {
    inline_keyboard: [
      [button("tw"), button("tm")],
      [button("lw"), button("lm")],
      [{ text: "← Інше місто", callback_data: "rb" }],
    ],
  };
}

function periodPromptText(city) {
  return `📊 <b>Звіт по відмовах: ${escapeHtml(cityTitle(city))}</b>\nОбери період.`;
}

function parseCallback(data) {
  if (typeof data !== "string") return null;
  if (data === "rb") return { action: "back" };
  let m = /^rc\|(.+)$/s.exec(data);
  if (m) return { action: "city", city: m[1] };
  m = /^rp\|(tw|tm|lw|lm)\|(.+)$/s.exec(data);
  if (m) return { action: "period", code: m[1], city: m[2] };
  return null;
}

module.exports = {
  LVIV,
  ALL_CITIES,
  PERIODS,
  tg,
  webhookSecret,
  parseRefusal,
  normalizeCity,
  normalizePhone,
  helpText,
  escapeHtml,
  kyivParts,
  kyivMidnight,
  addDays,
  weekdayIndex,
  mondayOf,
  previousMonth,
  parseMonth,
  parseDay,
  makePeriod,
  periodFor,
  fetchPeriod,
  recentCities,
  buildGeneralReport,
  buildCityReport,
  toMessages,
  reportMessages,
  scheduledMessages,
  cityFitsButtons,
  cityTitle,
  cityKeyboard,
  cityPromptText,
  periodKeyboard,
  periodPromptText,
  parseCallback,
};
