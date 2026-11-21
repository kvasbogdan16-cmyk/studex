// Чат відмов: розбір повідомлень, бот, побудова щомісячних звітів.
// Файл із «_» на початку Vercel не публікує як окрему функцію.

const crypto = require("crypto");
const { env } = require("./_telegram");

const TZ = "Europe/Kyiv";
const LVIV = "Львів";
const MAX_MESSAGE = 4000; // ліміт Telegram — 4096 символів, лишаємо запас

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
  person: ["ім'я", "имя", "кандидат", "клієнт", "хто"],
  comment: ["коментар", "комментарий", "примітка", "деталі"],
};

const CITY_ALIASES = {
  "львів": LVIV, "львов": LVIV, "lviv": LVIV, "lvov": LVIV, "lwów": LVIV,
  "київ": "Київ", "киев": "Київ", "kyiv": "Київ", "kiev": "Київ",
  "харків": "Харків", "харьков": "Харків", "kharkiv": "Харків",
  "одеса": "Одеса", "одесса": "Одеса", "odesa": "Одеса", "odessa": "Одеса",
  "дніпро": "Дніпро", "днепр": "Дніпро", "dnipro": "Дніпро",
};

const LIMITS = { city: 60, reason: 200, person: 100, comment: 1000 };

function unifyApostrophes(s) {
  return s.replace(/[ʼ’`´]/g, "'");
}

function fieldOf(label) {
  const key = unifyApostrophes(label.trim().toLowerCase());
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
  const key = unifyApostrophes(s.toLowerCase());
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

// Повертає { isAttempt, city, reason, person, comment, missing: [] }.
// Відмовою вважається повідомлення з полем («Місто:», «Причина:»…) або хештегом #відмова.
function parseRefusal(text) {
  const out = { isAttempt: false, city: "", reason: "", person: "", comment: "", missing: [] };
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
    const cityTag = tags.find((t) => !["відмова", "відмови", "отказ"].includes(t.toLowerCase()));
    if (cityTag) out.city = cityTag;
  }

  out.city = normalizeCity(out.city);
  out.reason = normalizeReason(out.reason);
  out.person = normalizeText(out.person, LIMITS.person);
  out.comment = normalizeText(out.comment, LIMITS.comment);

  if (!out.city) out.missing.push("місто");
  if (!out.reason) out.missing.push("причину");
  return out;
}

const TEMPLATE =
  "Місто: Львів\n" +
  "Причина: не влаштувала зарплата\n" +
  "Ім'я: Олена Коваль\n" +
  "Коментар: знайшла роботу ближче до дому";

function helpText() {
  return (
    "Я збираю відмови з цього чату й 1-го числа надсилаю звіт за минулий місяць " +
    "(загальний і окремий детальний по Львову).\n\n" +
    "Напиши відмову окремим повідомленням за шаблоном:\n\n" +
    `<code>${escapeHtml(TEMPLATE)}</code>\n\n` +
    "Обов'язкові лише «Місто» і «Причина». Місто можна вказати й хештегом: #Львів.\n" +
    "Помилився — просто відредагуй повідомлення. Щоб прибрати відмову зі звітів, " +
    "відповідай на неї командою /undo."
  );
}

// ---------- Дати й місяці (за київським часом) ----------

const MONTHS = ["січень", "лютий", "березень", "квітень", "травень", "червень",
  "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];

function kyivParts(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get("year"), m: get("month"), d: get("day"), hh: get("hour"), mm: get("minute") };
}

// { y, m } — місяць, за який звітуємо: попередній відносно «зараз» у Києві
function previousMonth({ y, m }) {
  return m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
}

function parseMonth(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(value || "");
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  return m >= 1 && m <= 12 ? { y, m } : null;
}

function monthDate({ y, m }) {
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

function monthName({ y, m }) {
  return `${MONTHS[m - 1]} ${y}`;
}

function daysInMonth({ y, m }) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const pad = (n) => String(n).padStart(2, "0");

// ---------- Звіти ----------

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Групує рядки за ключем без урахування регістру; підпис — перше написання
function countBy(rows, valueOf) {
  const map = new Map();
  for (const row of rows) {
    const label = valueOf(row) || "—";
    const key = unifyApostrophes(label.toLowerCase());
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

function totalLine(cur, prev, prevMonth) {
  return `Усього: <b>${cur}</b> · ${MONTHS[prevMonth.m - 1]}: ${prev} → ${delta(cur, prev)}`;
}

function messageLink(row) {
  const id = String(row.chat_id);
  // Посилання на повідомлення працюють лише в супергрупах (ID починається з -100)
  return id.startsWith("-100") ? `https://t.me/c/${id.slice(4)}/${row.message_id}` : "";
}

function isLviv(row) {
  return row.city === LVIV;
}

function buildGeneralReport(rows, prevRows, month, prevMonth) {
  const lines = [`📊 <b>Відмови за ${monthName(month)}</b>`, "", totalLine(rows.length, prevRows.length, prevMonth)];
  if (!rows.length) {
    lines.push("", "За цей місяць відмов у чаті не було.");
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
    lines.push(`• ${escapeHtml(item.label)} — ${item.count} · ${MONTHS[prevMonth.m - 1]}: ${prev} → ${delta(item.count, prev)}`);
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

function buildLvivReport(allRows, allPrevRows, month, prevMonth) {
  const rows = allRows.filter(isLviv);
  const prevRows = allPrevRows.filter(isLviv);
  const lines = [`📍 <b>${LVIV} — детальний звіт за ${monthName(month)}</b>`, "", totalLine(rows.length, prevRows.length, prevMonth)];
  if (!rows.length) {
    lines.push("", "За цей місяць відмов по Львову не було.");
    return lines;
  }
  lines.push(`Частка від усіх відмов: ${percent(rows.length, allRows.length)}%`);

  // Причини з порівнянням із минулим місяцем
  const prevReasons = countBy(prevRows, (r) => r.reason);
  lines.push("", "<b>Причини</b>");
  sorted(countBy(rows, (r) => r.reason)).forEach(([key, item], i) => {
    const prev = prevReasons.get(key)?.count || 0;
    lines.push(`${i + 1}. ${escapeHtml(item.label)} — ${item.count} (${percent(item.count, rows.length)}%) · ${MONTHS[prevMonth.m - 1]}: ${prev}`);
  });

  // По тижнях місяця: 1–7, 8–14, 15–21, 22–28, 29–кінець
  const lastDay = daysInMonth(month);
  const weeks = [];
  for (let start = 1; start <= lastDay; start += 7) weeks.push({ start, end: Math.min(start + 6, lastDay), count: 0 });
  for (const row of rows) {
    const { d } = kyivParts(new Date(row.created_at));
    weeks[Math.floor((d - 1) / 7)].count += 1;
  }
  const mm = pad(month.m);
  lines.push("", "<b>По тижнях</b>");
  for (const w of weeks) lines.push(`${pad(w.start)}.${mm}–${pad(w.end)}.${mm} — ${w.count}`);

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
    const who = row.person ? ` · ${escapeHtml(row.person)}` : "";
    const details = [row.comment && `<i>${escapeHtml(row.comment)}</i>`, row.author_name && `вніс(-ла): ${escapeHtml(row.author_name)}`]
      .filter(Boolean)
      .join(" · ");
    lines.push(`${i + 1}. ${date}${who} — ${escapeHtml(row.reason)}${details ? `\n    ${details}` : ""}`);
  });

  return lines;
}

// Ділить рядки на повідомлення до ліміту Telegram, не розриваючи рядок
function toMessages(lines) {
  const messages = [];
  let current = "";
  for (const raw of lines) {
    const line = raw.length > MAX_MESSAGE ? raw.slice(0, MAX_MESSAGE - 1) + "…" : raw;
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

module.exports = {
  LVIV,
  tg,
  webhookSecret,
  parseRefusal,
  normalizeCity,
  helpText,
  escapeHtml,
  kyivParts,
  previousMonth,
  parseMonth,
  monthDate,
  monthName,
  buildGeneralReport,
  buildLvivReport,
  toMessages,
};
