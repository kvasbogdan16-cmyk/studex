// Спільне для Telegram Mini App: перевірка даних Telegram і виклики бази.
// Файл із «_» на початку Vercel не публікує як окрему функцію.

const crypto = require("crypto");

const INIT_DATA_MAX_AGE = 24 * 60 * 60; // секунд: старіші дані відкидаємо

// Значення змінної Vercel без зайвих пробілів і переносів рядка (їх легко додати під час вставки)
function env(name) {
  return (process.env[name] || "").trim();
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Перевіряє підпис initData за правилами Telegram:
// secret = HMAC_SHA256("WebAppData", bot_token), hash = HMAC_SHA256(secret, data_check_string).
// Повертає користувача Telegram або кидає 401.
function verifyInitData(initData, botToken, now = Math.floor(Date.now() / 1000)) {
  if (!botToken) throw new HttpError(500, "Бот не налаштований у Vercel.");
  if (typeof initData !== "string" || !initData || initData.length > 4096) {
    throw new HttpError(401, "Відкрий Studex через бота в Telegram.");
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash") || "";
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");

  const valid =
    /^[0-9a-f]{64}$/.test(hash) &&
    crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(expected, "hex"));
  if (!valid) throw new HttpError(401, "Дані Telegram не пройшли перевірку. Відкрий Studex через бота.");

  const authDate = Number(params.get("auth_date"));
  if (!authDate || now - authDate > INIT_DATA_MAX_AGE) {
    throw new HttpError(401, "Сесія застаріла. Закрий і знову відкрий Studex у Telegram.");
  }

  let user;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch {
    user = null;
  }
  if (!user || !Number.isSafeInteger(user.id)) throw new HttpError(401, "Telegram не передав дані користувача.");
  return user;
}

function displayName(user) {
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  if (full.length >= 2) return full.slice(0, 100);
  if (user.username) return ("@" + user.username).slice(0, 100);
  return `Telegram ${user.id}`;
}

// Виклик функції бази через publishable-ключ (дозволи — у supabase-telegram.sql)
async function rpc(name, args) {
  const SUPABASE_URL = env("SUPABASE_URL");
  const SUPABASE_PUBLISHABLE_KEY = env("SUPABASE_PUBLISHABLE_KEY");
  const TG_SERVER_SECRET = env("TG_SERVER_SECRET");
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !TG_SERVER_SECRET) {
    throw new HttpError(500, "Сервер не налаштований: бракує змінних у Vercel.");
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ p_secret: TG_SERVER_SECRET, ...args }),
  });
  const text = await res.text();
  if (!res.ok) {
    if (text.includes("too_many_requests")) throw new HttpError(429, "Сьогодні ти вже надіслав 5 заявок. Спробуй завтра.");
    console.error(`[tg] rpc ${name}:`, res.status, text.slice(0, 300));
    throw new HttpError(502, "Не вдалося зв'язатися з базою. Спробуй ще раз.");
  }
  return text ? JSON.parse(text) : null;
}

// Порівнює секрети за сталий час (через SHA-256, щоб довжина не мала значення)
function sameSecret(given, expected) {
  if (typeof given !== "string" || !expected) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function parseBody(req) {
  let body = req.body || {};
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      throw new HttpError(400, "Некоректні дані.");
    }
  }
  return body;
}

function sendError(res, err) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error("[tg]", err);
  return res.status(500).json({ error: "Щось пішло не так. Спробуй ще раз." });
}

module.exports = { env, HttpError, verifyInitData, displayName, rpc, sameSecret, parseBody, sendError };
