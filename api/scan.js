// POST /api/scan — розпізнає візитку через Claude API і повертає поля для екрана перевірки.
// Нічого не зберігає: заявку й оригінал зберігає адмінка після того, як адмін перевірить поля.
//
// Доступ лише для адмінів: браузер надсилає токен входу Supabase, функція перевіряє його
// і викликає is_admin(). Без цього будь-хто міг би витрачати ключ Claude.
//
// Змінні середовища Vercel:
//   ANTHROPIC_API_KEY         — ключ Claude API (секрет)
//   SUPABASE_URL              — адреса проєкту Supabase
//   SUPABASE_PUBLISHABLE_KEY  — publishable-ключ Supabase

const { Anthropic } = require("@anthropic-ai/sdk");
const { betaZodOutputFormat } = require("@anthropic-ai/sdk/helpers/beta/zod");
const { z } = require("zod");

const MODEL = "claude-opus-5-5";
const MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const MAX_FILE_BYTES = 3 * 1024 * 1024; // після стиснення в браузері; ліміт запиту Vercel — 4,5 МБ

const CardSchema = z.object({
  is_business_card: z.boolean(),
  reason: z.string(),
  name: z.string(),
  company: z.string(),
  job_title: z.string(),
  phone: z.string(),
  email: z.string(),
  website: z.string(),
  notes: z.string(),
});

const SYSTEM = `Ти розпізнаєш візитки для CRM сервісу Studex (робота для студентів в Україні). Адмін фотографує візитку роботодавця або партнера після зустрічі, а ти витягуєш контакти, щоб створити картку клієнта.

Правила:
- is_business_card = true, якщо на зображенні візитка або схожий документ із контактами людини чи компанії (бейдж, сторінка з контактами). Для всього іншого (пейзаж, селфі, чек, порожній аркуш, скриншот без контактів) — false, а в reason коротко українською поясни, що на зображенні.
- Переписуй дані так, як вони надруковані: ім'я та компанію не перекладай і не транслітеруй.
- name — ім'я та прізвище людини. Якщо людини немає, а є лише компанія, залиш name порожнім.
- phone — основний номер; український номер приведи до формату +380XXXXXXXXX. Якщо номерів кілька, інші додай у notes.
- website, адреса, месенджери, другий телефон та інші корисні деталі — у notes коротким рядком.
- Нічого не вигадуй: якщо поля на візитці немає або його не видно, залиш порожній рядок.
- reason для справжньої візитки — порожній рядок, або коротке попередження, якщо щось погано видно.`;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Перевіряє, що токен належить адміну (той самий is_admin(), що й у базі)
async function requireAdmin(req) {
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) throw new HttpError(500, "Supabase не налаштовано у Vercel");

  const auth = req.headers.authorization || "";
  if (!/^Bearer \S+$/.test(auth)) throw new HttpError(401, "Увійди в адмін-панель ще раз.");

  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/is_admin`, {
    method: "POST",
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: auth, "Content-Type": "application/json" },
    body: "{}",
  });
  if (res.status === 401) throw new HttpError(401, "Сесія закінчилась. Увійди в адмін-панель ще раз.");
  if (!res.ok) throw new HttpError(502, "Не вдалося перевірити доступ. Спробуй ще раз.");
  if ((await res.json()) !== true) throw new HttpError(403, "Розпізнавання доступне лише адмінам.");
}

function readFile(body) {
  const mediaType = typeof body.mediaType === "string" ? body.mediaType : "";
  const data = typeof body.data === "string" ? body.data : "";

  if (!MEDIA_TYPES.includes(mediaType)) {
    throw new HttpError(400, "Підтримуються фото (JPEG, PNG, WebP) і PDF.");
  }
  if (!data || !/^[A-Za-z0-9+/]+=*$/.test(data)) throw new HttpError(400, "Файл не отримано. Спробуй ще раз.");
  if (Math.floor((data.length * 3) / 4) > MAX_FILE_BYTES) throw new HttpError(413, "Файл завеликий: до 3 МБ.");
  return { mediaType, data };
}

async function recognize({ mediaType, data }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new HttpError(500, "Ключ Claude API не налаштовано у Vercel.");

  // Тайм-аут менший за maxDuration функції (60 с), щоб встигнути відповісти зрозумілою помилкою
  const client = new Anthropic({ timeout: 50_000, maxRetries: 1 });

  const fileBlock =
    mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: mediaType, data } }
      : { type: "image", source: { type: "base64", media_type: mediaType, data } };

  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default", // якщо модель відмовить, запит повторить запасна модель
    output_config: { effort: "low", format: betaZodOutputFormat(CardSchema) },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [fileBlock, { type: "text", text: "Розпізнай цю візитку." }],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new HttpError(422, "Claude не зміг обробити це зображення. Спробуй інше фото.");
  }
  if (!response.parsed_output) {
    console.error("[scan] no parsed output, stop_reason:", response.stop_reason);
    throw new HttpError(502, "Не вдалося розпізнати візитку. Спробуй ще раз.");
  }
  return response.parsed_output;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    await requireAdmin(req);

    let body = req.body || {};
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        throw new HttpError(400, "Некоректні дані.");
      }
    }

    const card = await recognize(readFile(body));

    if (!card.is_business_card) {
      const what = card.reason ? ` ${card.reason.replace(/\.?$/, ".")}` : "";
      return res.status(422).json({
        error: `Це не схоже на візитку.${what} Нічого не збережено — сфотографуй візитку ще раз.`,
      });
    }

    const { is_business_card, ...fields } = card;
    return res.status(200).json({ ok: true, card: fields });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });

    if (err instanceof Anthropic.AuthenticationError) {
      console.error("[scan] Claude API key rejected");
      return res.status(500).json({ error: "Ключ Claude API недійсний. Перевір його у Vercel." });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: "Забагато запитів до Claude. Спробуй за хвилину." });
    }
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      return res.status(504).json({ error: "Claude відповідав задовго. Спробуй ще раз." });
    }
    if (err instanceof Anthropic.APIError) {
      console.error("[scan] Claude API error", err.status, err.message);
      return res.status(502).json({ error: "Сервіс розпізнавання тимчасово недоступний. Спробуй ще раз." });
    }

    console.error("[scan]", err);
    return res.status(500).json({ error: "Щось пішло не так. Спробуй ще раз." });
  }
};

module.exports.CardSchema = CardSchema;
