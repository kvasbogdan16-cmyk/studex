// POST /api/lead — зберігає заявку в Supabase і надсилає сповіщення в Telegram.
// Джерело («Сайт») і перший етап воронки («Нова») заявці ставить сама база (supabase-crm.sql).
// Усі ключі — у змінних середовища Vercel (Settings → Environment Variables):
//   SUPABASE_URL              — адреса проєкту Supabase
//   SUPABASE_PUBLISHABLE_KEY  — publishable-ключ Supabase (дозволяє лише додавати заявки)
//   TELEGRAM_BOT_TOKEN        — токен бота від @BotFather (секрет)
//   TELEGRAM_CHAT_ID          — куди слати повідомлення (ваш чат із ботом)

const ADMIN_URL = "https://studex-ochre.vercel.app/admin";

function text(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function validate(body) {
  const lead = {
    name: text(body.name, 100),
    phone: text(body.phone, 30),
    comment: text(body.comment, 1000) || null,
  };
  const digits = lead.phone.replace(/\D/g, "");

  if (lead.name.length < 2) return { error: "Вкажи ім'я" };
  if (digits.length < 10 || digits.length > 13) return { error: "Перевір номер телефону" };
  return { lead };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function saveLead(lead) {
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) throw new Error("Supabase env vars are missing");

  const res = await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(lead),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Supabase ${res.status}: ${text}`);
    // Ліміт заявок перевіряє база (тригер у supabase-ratelimit.sql)
    if (text.includes("too_many_requests")) err.code = "rate_limited";
    throw err;
  }
}

// source — звідки заявка; extra — додаткові рядки (наприклад, нікнейм у Telegram)
function buildMessage(lead, { source = "Сайт", extra = [] } = {}) {
  const date = new Intl.DateTimeFormat("uk-UA", {
    timeZone: "Europe/Kyiv",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());

  const lines = [
    source === "Сайт" ? "🆕 <b>Нова заявка на Studex</b>" : `🆕 <b>Нова заявка на Studex (${escapeHtml(source)})</b>`,
    "",
    `👤 <b>Ім'я:</b> ${escapeHtml(lead.name)}`,
    ...extra.map(escapeHtml),
    `📞 <b>Телефон:</b> ${escapeHtml(lead.phone)}`,
    `💬 <b>Коментар:</b> ${lead.comment ? escapeHtml(lead.comment) : "—"}`,
    `🕒 <b>Час:</b> ${date}`,
    `🌐 <b>Джерело:</b> ${escapeHtml(source)}`,
    `📌 <b>Етап:</b> Нова`,
    "",
    `<a href="${ADMIN_URL}">Відкрити адмін-панель</a>`,
  ];
  return lines.join("\n");
}

async function notifyTelegram(lead, options) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN не задано — сповіщення пропущено");
    return "skipped";
  }

  // Лише явно заданий чат. Бот публічний (Mini App), тож «останній, хто написав боту»
  // може бути будь-яким студентом — заявки з персональними даними не можна слати навмання.
  const chatId = (process.env.TELEGRAM_CHAT_ID || "").trim();
  if (!chatId) {
    console.warn("[telegram] TELEGRAM_CHAT_ID не задано — сповіщення пропущено");
    return "no-chat";
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: buildMessage(lead, options),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error("[telegram] Помилка надсилання:", data.error_code, data.description);
    return data.error_code === 401 ? "bad-token" : "error";
  }
  return "sent";
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Лише JSON: звичайна HTML-форма з чужого сайту так надіслати не може
  // (наш script.js завжди шле application/json)
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    return res.status(415).json({ error: "Некоректні дані" });
  }

  let body = req.body || {};
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Некоректні дані" });
    }
  }
  if (!body || typeof body !== "object") return res.status(400).json({ error: "Некоректні дані" });

  // Пастку заповнив бот: відповідаємо «успіх», але нічого не зберігаємо і не надсилаємо
  if (typeof body.hp === "string" && body.hp.trim()) {
    console.warn("[lead] відкинуто заявку бота (заповнене поле-пастка)");
    return res.status(200).json({ ok: true, telegram: "skipped" });
  }

  const { lead, error } = validate(body);
  if (error) return res.status(400).json({ error });

  try {
    await saveLead(lead);
  } catch (err) {
    if (err.code === "rate_limited") {
      // Видно в логах Vercel: якщо таких багато, форму хтось флудить
      console.warn("[lead] rate_limited");
      return res.status(429).json({ error: "Забагато заявок. Спробуй пізніше." });
    }
    console.error("[supabase]", err.message);
    return res.status(502).json({ error: "Не вдалося зберегти заявку" });
  }

  // Заявка вже збережена: збій Telegram не повинен ламати відповідь сайту
  let telegram = "error";
  try {
    telegram = await notifyTelegram(lead);
  } catch (err) {
    console.error("[telegram]", err.message);
  }

  return res.status(200).json({ ok: true, telegram });
};

module.exports.buildMessage = buildMessage;
module.exports.notifyTelegram = notifyTelegram;
module.exports.validate = validate;
