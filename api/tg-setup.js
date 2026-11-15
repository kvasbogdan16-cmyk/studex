// POST /api/tg-setup — один раз налаштовує бота: кнопка меню відкриває Mini App, опис бота.
// Захищено секретом TG_SERVER_SECRET (заголовок X-Setup-Secret), тож викликати може лише власник.

const crypto = require("crypto");

async function bot(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

function sameSecret(given, expected) {
  if (typeof given !== "string" || !expected) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!sameSecret(req.headers["x-setup-secret"], process.env.TG_SERVER_SECRET)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (!process.env.TELEGRAM_BOT_TOKEN) return res.status(500).json({ error: "TELEGRAM_BOT_TOKEN не задано" });

  try {
    const url = `https://${req.headers.host}/tg`;
    const me = await bot("getMe");
    await bot("setChatMenuButton", { menu_button: { type: "web_app", text: "Вакансії", web_app: { url } } });
    await bot("setMyShortDescription", { short_description: "Робота для студентів: вакансії та заявка в один дотик." });
    await bot("setMyDescription", {
      description: "Studex — робота, яка розуміє, що ти ще навчаєшся.\n\nНатисни кнопку «Вакансії» внизу, обери вакансію і відгукнись — ми зв'яжемося з тобою.",
    });
    return res.status(200).json({ ok: true, bot: "@" + me.username, url });
  } catch (err) {
    console.error("[tg-setup]", err.message);
    return res.status(502).json({ error: err.message });
  }
};
