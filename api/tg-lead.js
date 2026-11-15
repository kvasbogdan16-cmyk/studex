// POST /api/tg-lead — заявка з Telegram Mini App потрапляє в CRM з джерелом «Telegram».
// Ім'я та ID беремо з перевірених даних Telegram, а не з того, що надіслав браузер.

const { HttpError, verifyInitData, displayName, rpc, parseBody, sendError } = require("./_telegram");
const { notifyTelegram } = require("./lead");

function text(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const body = parseBody(req);
    const user = verifyInitData(body.initData, process.env.TELEGRAM_BOT_TOKEN);

    const phone = text(body.phone, 30);
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 13) throw new HttpError(400, "Перевір номер телефону: потрібно 10–13 цифр.");

    const vacancy = text(body.vacancy, 100);
    const note = text(body.comment, 800);
    const comment = [vacancy && `Вакансія: ${vacancy}`, note].filter(Boolean).join("\n") || null;

    const lead = { name: displayName(user), phone, comment };
    const id = await rpc("tg_create_lead", {
      p_telegram_id: user.id,
      p_username: user.username || null,
      p_name: lead.name,
      p_phone: lead.phone,
      p_comment: lead.comment,
    });

    // Заявка вже збережена: збій сповіщення не повинен ламати відповідь
    try {
      await notifyTelegram(lead, {
        source: "Telegram",
        extra: user.username ? [`✈️ Telegram: @${user.username}`] : [],
      });
    } catch (err) {
      console.error("[tg-lead] notify:", err.message);
    }

    return res.status(200).json({ ok: true, id });
  } catch (err) {
    return sendError(res, err);
  }
};
