// GET /api/refusals-report — автоматичні звіти в чат відмов.
// Vercel Cron запускає його щодня о 07:00 UTC (vercel.json) із заголовком Authorization: Bearer CRON_SECRET:
//   • у понеділок — звіт за минулий тиждень (пн–нд);
//   • 1-го числа — звіт за минулий місяць;
//   • в інші дні нічого не надсилає.
// Кожен звіт — загальний по всіх містах + детальний по Львову. Межі періодів — за київським часом.
//
// Вручну (з тим самим заголовком):
//   ?month=2026-10        — звіт за місяць
//   ?week=2026-11-16      — звіт за тиждень, у який входить ця дата
//   ?type=week|month      — звіт за минулий тиждень / місяць
//   &dry=1                — лише показати текст у відповіді, нічого не надсилати в Telegram

const { env, sameSecret } = require("./_telegram");
const {
  tg, kyivParts, weekdayIndex, parseMonth, parseDay, makePeriod, periodFor, fetchPeriod, scheduledMessages, LVIV,
} = require("./_refusals");

// Які звіти потрібні: { periods } або { error }
function choosePeriods(query, now) {
  if (query.month) {
    const month = parseMonth(String(query.month));
    if (!month) return { error: "month має бути у форматі YYYY-MM" };
    return { periods: [makePeriod("month", { ...month, d: 1 })] };
  }
  if (query.week) {
    const day = parseDay(String(query.week));
    if (!day) return { error: "week має бути датою у форматі YYYY-MM-DD" };
    return { periods: [makePeriod("week", day)] };
  }
  if (query.type) {
    if (query.type === "week") return { periods: [periodFor("lw", now)] };
    if (query.type === "month") return { periods: [periodFor("lm", now)] };
    return { error: "type має бути week або month" };
  }

  // Автоматичний запуск: дивимося, який сьогодні день у Києві
  const today = kyivParts(now);
  const periods = [];
  if (weekdayIndex(today) === 0) periods.push(periodFor("lw", now));
  if (today.d === 1) periods.push(periodFor("lm", now));
  return { periods };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const cronSecret = env("CRON_SECRET");
  if (!sameSecret(req.headers.authorization, cronSecret && `Bearer ${cronSecret}`)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const query = req.query || {};
  const dry = query.dry === "1" || query.dry === "true";
  const { periods, error } = choosePeriods(query, new Date());
  if (error) return res.status(400).json({ error });
  if (!periods.length) {
    return res.status(200).json({ ok: true, sent: false, reason: "Сьогодні не понеділок і не 1-ше число — звітів за розкладом немає" });
  }

  const chatId = env("REFUSALS_CHAT_ID");
  if (!dry && (!chatId || !env("REFUSALS_BOT_TOKEN"))) {
    return res.status(500).json({ error: "REFUSALS_CHAT_ID або REFUSALS_BOT_TOKEN не задано у Vercel" });
  }

  try {
    const reports = [];
    for (const period of periods) {
      const { rows, prevRows } = await fetchPeriod(period);
      const messages = scheduledMessages(period, rows, prevRows);
      if (!dry) {
        // По черзі, щоб повідомлення прийшли в правильному порядку
        for (const text of messages) {
          await tg("sendMessage", {
            chat_id: chatId,
            text,
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          });
        }
      }
      reports.push({
        period: period.title,
        total: rows.length,
        lviv: rows.filter((r) => r.city === LVIV).length,
        messages: dry ? messages : messages.length,
      });
    }
    return res.status(200).json({ ok: true, sent: !dry, reports });
  } catch (err) {
    console.error("[refusals-report]", err.message);
    return res.status(502).json({ error: err.message });
  }
};

module.exports.choosePeriods = choosePeriods;
