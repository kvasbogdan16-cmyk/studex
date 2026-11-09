// POST /api/lead — зберігає заявку в Supabase і надсилає сповіщення в Telegram.
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
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}

// Якщо TELEGRAM_CHAT_ID ще не задано — беремо чат, з якого востаннє писали боту
async function findChatId(token) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const data = await res.json();
  if (!data.ok) {
    console.error("[telegram] getUpdates:", data.error_code, data.description);
    throw new Error(data.error_code === 401 ? "bad-token" : "getUpdates-failed");
  }
  const messages = data.result
    .map((u) => u.message || u.my_chat_member)
    .filter((m) => m && m.chat && m.chat.type === "private");
  return messages.length ? messages[messages.length - 1].chat.id : null;
}

function buildMessage(lead) {
  const date = new Intl.DateTimeFormat("uk-UA", {
    timeZone: "Europe/Kyiv",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());

  const lines = [
    "🆕 <b>Нова заявка на Studex</b>",
    "",
    `👤 <b>Ім'я:</b> ${escapeHtml(lead.name)}`,
    `📞 <b>Телефон:</b> ${escapeHtml(lead.phone)}`,
    `💬 <b>Коментар:</b> ${lead.comment ? escapeHtml(lead.comment) : "—"}`,
    `🕒 <b>Час:</b> ${date}`,
    `📌 <b>Статус:</b> нова`,
    "",
    `<a href="${ADMIN_URL}">Відкрити адмін-панель</a>`,
  ];
  return lines.join("\n");
}

async function notifyTelegram(lead) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN не задано — сповіщення пропущено");
    return "skipped";
  }

  let chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    chatId = await findChatId(token);
    if (!chatId) {
      console.warn("[telegram] Не знайдено чат: напиши боту /start");
      return "no-chat";
    }
    console.log(`[telegram] Знайдено TELEGRAM_CHAT_ID=${chatId}`);
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: buildMessage(lead),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error("[telegram] Помилка надсилання:", data.description);
    return "error";
  }
  return "sent";
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = req.body || {};
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Некоректні дані" });
    }
  }

  const { lead, error } = validate(body);
  if (error) return res.status(400).json({ error });

  try {
    await saveLead(lead);
  } catch (err) {
    console.error("[supabase]", err.message);
    return res.status(502).json({ error: "Не вдалося зберегти заявку" });
  }

  // Заявка вже збережена: збій Telegram не повинен ламати відповідь сайту
  let telegram = "error";
  try {
    telegram = await notifyTelegram(lead);
  } catch (err) {
    console.error("[telegram]", err.message);
    if (err.message === "bad-token") telegram = "bad-token";
  }

  return res.status(200).json({ ok: true, telegram });
};

module.exports.buildMessage = buildMessage;
module.exports.validate = validate;
