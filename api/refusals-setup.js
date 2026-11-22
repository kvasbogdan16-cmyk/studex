// POST /api/refusals-setup — один раз підключає бота чату відмов: вебхук і список команд.
// Захищено секретом TG_SERVER_SECRET (заголовок X-Setup-Secret), тож викликати може лише власник.

const { env, sameSecret } = require("./_telegram");
const { tg, webhookSecret } = require("./_refusals");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!sameSecret(req.headers["x-setup-secret"], env("TG_SERVER_SECRET"))) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (!env("REFUSALS_BOT_TOKEN")) return res.status(500).json({ error: "REFUSALS_BOT_TOKEN не задано" });

  try {
    const url = `https://${req.headers.host}/api/refusals-bot`;
    const me = await tg("getMe");
    await tg("setWebhook", {
      url,
      secret_token: webhookSecret(),
      allowed_updates: ["message", "edited_message", "callback_query"],
    });
    const commands = [
      { command: "report", description: "Звіт по відмовах: місто і період" },
      { command: "help", description: "Шаблон відмови і як працює бот" },
      { command: "undo", description: "Прибрати відмову зі звітів (у відповідь на неї)" },
    ];
    await tg("setMyCommands", { commands });
    await tg("setMyCommands", { commands, scope: { type: "all_group_chats" } });

    const warnings = [];
    // Без цього бот у групі бачить лише команди, а не звичайні повідомлення
    if (!me.can_read_all_group_messages) {
      warnings.push("Бот не бачить звичайних повідомлень у групі: зроби його адміном групи або вимкни Group Privacy в @BotFather і додай бота в групу заново.");
    }
    if (!env("REFUSALS_CHAT_ID")) {
      warnings.push("REFUSALS_CHAT_ID не задано: напиши /help у групі, бот покаже ID чату.");
    }
    if (!env("CRON_SECRET")) {
      warnings.push("CRON_SECRET не задано: без нього автоматичні звіти (щотижня й щомісяця) не запустяться.");
    }
    return res.status(200).json({ ok: true, bot: "@" + me.username, webhook: url, warnings });
  } catch (err) {
    console.error("[refusals-setup]", err.message);
    return res.status(502).json({ error: err.message });
  }
};
