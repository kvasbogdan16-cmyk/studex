// GET /api/refusals-report — щомісячний звіт у чат відмов.
// Запускає Vercel Cron 1-го числа (vercel.json) із заголовком Authorization: Bearer CRON_SECRET.
// Звіт за минулий місяць (за київським часом): загальний + окремий детальний по Львову.
// Для перевірки можна викликати вручну з тим самим заголовком: ?month=2026-10.

const { env, rpc, sameSecret } = require("./_telegram");
const {
  tg, kyivParts, previousMonth, parseMonth, monthDate, buildGeneralReport, buildLvivReport, toMessages, LVIV,
} = require("./_refusals");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const cronSecret = env("CRON_SECRET");
  if (!sameSecret(req.headers.authorization, cronSecret && `Bearer ${cronSecret}`)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const chatId = env("REFUSALS_CHAT_ID");
  if (!chatId || !env("REFUSALS_BOT_TOKEN")) {
    return res.status(500).json({ error: "REFUSALS_CHAT_ID або REFUSALS_BOT_TOKEN не задано у Vercel" });
  }

  let month;
  if (req.query && req.query.month) {
    month = parseMonth(String(req.query.month));
    if (!month) return res.status(400).json({ error: "month має бути у форматі YYYY-MM" });
  } else {
    month = previousMonth(kyivParts(new Date()));
  }
  const prevMonth = previousMonth(month);

  try {
    const [rows, prevRows] = await Promise.all([
      rpc("refusals_month", { p_month: monthDate(month) }),
      rpc("refusals_month", { p_month: monthDate(prevMonth) }),
    ]);

    const messages = [
      ...toMessages(buildGeneralReport(rows, prevRows, month, prevMonth)),
      ...toMessages(buildLvivReport(rows, prevRows, month, prevMonth)),
    ];
    // По черзі, щоб повідомлення прийшли в правильному порядку
    for (const text of messages) {
      await tg("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    }

    return res.status(200).json({
      ok: true,
      month: monthDate(month).slice(0, 7),
      total: rows.length,
      lviv: rows.filter((r) => r.city === LVIV).length,
      messages: messages.length,
    });
  } catch (err) {
    console.error("[refusals-report]", err.message);
    return res.status(502).json({ error: err.message });
  }
};
