// POST /api/generate — генерує картинку для вакансії через OpenAI (GPT Image) на сервері.
// Ключ OpenAI лежить лише у Vercel і в браузер не потрапляє.
//
// Функція діє від імені адміна з його токеном входу Supabase:
//   begin_generation (перевірка адміна й ліміту 5/день) → OpenAI → сховище generations → finish_generation.
// Якщо OpenAI не впорався, спроба позначається невдалою і в ліміт не рахується.
//
// Змінні середовища Vercel: OPENAI_API_KEY (секрет), SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY.

const crypto = require("crypto");
const { env, HttpError, parseBody, sendError } = require("./_telegram");

const MODEL = "gpt-image-2.5-flare";
const SIZES = { post: "1024x1024", banner: "1536x1024", story: "1024x1536" };
const STYLES = {
  photo: "реалістичне фото, природне світло, як для професійної фотосесії",
  illustration: "яскрава сучасна цифрова ілюстрація",
  flat: "плоска векторна графіка з простими формами, фірмові кольори: фіолетовий #5b3df5 і лаймовий #c6f432",
};
const OPENAI_TIMEOUT_MS = 55_000; // менше за maxDuration функції (60 с)

function buildPrompt(description, style) {
  return [
    "Зображення для поста про вакансію на Studex — сервісі пошуку роботи для студентів в Україні.",
    `Стиль: ${STYLES[style]}.`,
    `Що зобразити: ${description}`,
    "Позитивний, дружній настрій. Без тексту, написів, логотипів і водяних знаків на зображенні.",
  ].join("\n");
}

// Запит до Supabase від імені адміна (його токен + publishable-ключ, діють правила RLS)
async function supabase(path, token, { method = "POST", body, headers = {} } = {}) {
  const res = await fetch(`${env("SUPABASE_URL")}${path}`, {
    method,
    headers: { apikey: env("SUPABASE_PUBLISHABLE_KEY"), Authorization: `Bearer ${token}`, ...headers },
    body,
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

async function rpc(name, args, token) {
  const r = await supabase(`/rest/v1/rpc/${name}`, token, {
    body: JSON.stringify(args),
    headers: { "Content-Type": "application/json" },
  });
  if (r.ok) return r.text ? JSON.parse(r.text) : null;
  if (r.text.includes("daily_limit")) {
    throw new HttpError(429, "Ліміт вичерпано: 5 генерацій на день. Наступні будуть доступні завтра.");
  }
  if (r.status === 401) throw new HttpError(401, "Сесія закінчилась. Увійди в адмін-панель ще раз.");
  if (r.text.includes("forbidden")) throw new HttpError(403, "Генерація доступна лише адмінам.");
  console.error(`[generate] rpc ${name}:`, r.status, r.text.slice(0, 300));
  throw new HttpError(502, "Не вдалося зв'язатися з базою. Спробуй ще раз.");
}

async function openaiImage(prompt, size, userId) {
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${env("OPENAI_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      size,
      quality: "medium",
      output_format: "jpeg",
      output_compression: 85,
      n: 1,
      // Анонімний ідентифікатор адміна для модерації OpenAI (без email і імені)
      safety_identifier: crypto.createHash("sha256").update(String(userId)).digest("hex").slice(0, 64),
    }),
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = (data.error && (data.error.code || data.error.type)) || "";
    const message = (data.error && data.error.message) || `HTTP ${res.status}`;
    console.error("[generate] OpenAI:", res.status, code, message.slice(0, 300));
    if (res.status === 401) throw new HttpError(500, "Ключ OpenAI недійсний. Перевір OPENAI_API_KEY у Vercel.");
    if (res.status === 429) throw new HttpError(429, "OpenAI зараз перевантажений або закінчився баланс. Спробуй пізніше.");
    if (/moderation|safety/i.test(code + message)) {
      throw new HttpError(422, "OpenAI відхилив цей опис через правила безпеки. Переформулюй і спробуй ще раз.");
    }
    if (/verif/i.test(message)) {
      throw new HttpError(403, "OpenAI вимагає підтвердити організацію (Organization Verification) у кабінеті OpenAI.");
    }
    throw new HttpError(502, "Сервіс генерації тимчасово недоступний. Спробуй ще раз.");
  }
  const b64 = data.data && data.data[0] && data.data[0].b64_json;
  if (!b64) throw new HttpError(502, "OpenAI не повернув картинку. Спробуй ще раз.");
  return Buffer.from(b64, "base64");
}

// Хто робить запит (id потрібен для шляху файлу і safety_identifier)
async function currentUser(token) {
  const r = await supabase("/auth/v1/user", token, { method: "GET" });
  if (r.status === 401 || r.status === 403) throw new HttpError(401, "Сесія закінчилась. Увійди в адмін-панель ще раз.");
  if (!r.ok) throw new HttpError(502, "Не вдалося перевірити вхід. Спробуй ще раз.");
  return JSON.parse(r.text);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let token = null;
  let generationId = null;
  try {
    if (!env("SUPABASE_URL") || !env("SUPABASE_PUBLISHABLE_KEY")) throw new HttpError(500, "Supabase не налаштовано у Vercel.");
    if (!env("OPENAI_API_KEY")) throw new HttpError(500, "Ключ OpenAI не налаштовано у Vercel.");

    const auth = req.headers.authorization || "";
    const match = /^Bearer (\S+)$/.exec(auth);
    if (!match) throw new HttpError(401, "Увійди в адмін-панель ще раз.");
    token = match[1];

    const body = parseBody(req);
    const description = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const style = body.style;
    const size = SIZES[body.format];
    if (description.length < 3) throw new HttpError(400, "Опиши, що має бути на картинці (від 3 символів).");
    if (description.length > 1000) throw new HttpError(400, "Опис задовгий: до 1000 символів.");
    if (!STYLES[style]) throw new HttpError(400, "Обери стиль.");
    if (!size) throw new HttpError(400, "Обери формат.");

    const user = await currentUser(token);
    generationId = await rpc("begin_generation", { p_prompt: description, p_style: style, p_size: size }, token);

    const image = await openaiImage(buildPrompt(description, style), size, user.id);

    const path = `img/${new Date().toISOString().slice(0, 7)}/${generationId}-${crypto.randomUUID()}.jpg`;
    const upload = await supabase(`/storage/v1/object/generations/${path}`, token, {
      body: image,
      headers: { "Content-Type": "image/jpeg" },
    });
    if (!upload.ok) {
      console.error("[generate] upload:", upload.status, upload.text.slice(0, 300));
      throw new HttpError(502, "Картинку згенеровано, але не вдалося її зберегти. Спробуй ще раз.");
    }

    await rpc("finish_generation", { p_id: generationId, p_image_path: path }, token);
    const quota = await rpc("generation_quota", {}, token);

    return res.status(200).json({ ok: true, id: generationId, image_path: path, quota: quota && quota[0] });
  } catch (err) {
    // Невдала спроба не забирає місце в ліміті
    if (generationId && token) {
      try {
        await rpc("fail_generation", { p_id: generationId, p_error: String(err.message || err) }, token);
      } catch (e) {
        console.error("[generate] fail_generation:", e.message);
      }
    }
    if (err && err.name === "TimeoutError") {
      return res.status(504).json({ error: "Генерація тривала задовго. Спробуй простіший опис або ще раз." });
    }
    return sendError(res, err);
  }
};

module.exports.buildPrompt = buildPrompt;
