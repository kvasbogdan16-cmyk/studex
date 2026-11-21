// POST /api/refusals-bot — вебхук бота чату відмов.
// Telegram надсилає сюди повідомлення з групи; відмови за шаблоном зберігаються в базі.
// Запити без правильного X-Telegram-Bot-Api-Secret-Token відкидаються.

const { env, rpc, displayName, sameSecret, parseBody } = require("./_telegram");
const { tg, webhookSecret, parseRefusal, helpText } = require("./_refusals");

// «/undo@studex_bot args» → «undo»
function commandOf(text) {
  const m = /^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i.exec(text || "");
  return m ? m[1].toLowerCase() : null;
}

function reply(msg, text) {
  return tg("sendMessage", {
    chat_id: msg.chat.id,
    message_thread_id: msg.is_topic_message ? msg.message_thread_id : undefined,
    text,
    parse_mode: "HTML",
    reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
    link_preview_options: { is_disabled: true },
  });
}

async function react(chatId, messageId, emoji) {
  try {
    await tg("setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: emoji ? [{ type: "emoji", emoji }] : [],
    });
  } catch (err) {
    // Реакції можуть бути вимкнені в чаті — це не завада
    console.warn("[refusals-bot] reaction:", err.message);
  }
}

async function handleUndo(msg) {
  const target = msg.reply_to_message;
  if (!target) {
    await reply(msg, "Надішли /undo у відповідь на повідомлення з відмовою, яку треба прибрати зі звітів.");
    return;
  }
  const deleted = await rpc("refusals_delete", {
    p_chat_id: msg.chat.id,
    p_message_id: target.message_id,
    p_author_id: msg.from.id,
  });
  if (deleted) {
    await react(msg.chat.id, target.message_id, null);
    await reply(msg, "Готово: цю відмову прибрано зі звітів.");
  } else {
    await reply(msg, "Не знайшов тут твоєї відмови. Прибрати можна лише відмову, яку написав ти сам.");
  }
}

async function handleRefusal(msg, edited) {
  const parsed = parseRefusal(msg.text || msg.caption || "");

  if (!parsed.isAttempt) {
    // Повідомлення відредагували так, що відмови в ньому більше немає
    if (edited) {
      const deleted = await rpc("refusals_delete", { p_chat_id: msg.chat.id, p_message_id: msg.message_id, p_author_id: null });
      if (deleted) await react(msg.chat.id, msg.message_id, null);
    }
    return;
  }

  if (parsed.missing.length) {
    const prefix = edited ? "Зміни не збережено: бракує" : "Не можу зберегти відмову: бракує";
    await reply(msg, `${prefix} ${parsed.missing.join(" і ")}.\n\n${helpText()}`);
    return;
  }

  await rpc("refusals_save", {
    p_chat_id: msg.chat.id,
    p_message_id: msg.message_id,
    p_city: parsed.city,
    p_reason: parsed.reason,
    p_person: parsed.person,
    p_comment: parsed.comment,
    p_author_id: msg.from.id,
    p_author_name: displayName(msg.from),
    p_created_at: new Date(msg.date * 1000).toISOString(),
  });
  await react(msg.chat.id, msg.message_id, "👍");
}

async function handleUpdate(update) {
  const edited = Boolean(update.edited_message);
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat || !msg.from || msg.from.is_bot) return;

  const text = msg.text || msg.caption || "";
  const command = commandOf(text);
  const chatId = String(msg.chat.id);
  const ownChat = chatId === env("REFUSALS_CHAT_ID");

  if (command === "help" || command === "start") {
    if (edited) return;
    // Поки чат не налаштований, підказуємо його ID — без нього бот не знає, де працювати
    const setup = ownChat ? "" : `\n\nID цього чату: <code>${chatId}</code>. Додай його у Vercel як REFUSALS_CHAT_ID, якщо це чат відмов.`;
    await reply(msg, helpText() + setup);
    return;
  }

  // Відмови приймаємо лише з одного чату
  if (!ownChat) return;

  if (command === "undo") {
    if (!edited) await handleUndo(msg);
    return;
  }
  if (command) return;

  try {
    await handleRefusal(msg, edited);
  } catch (err) {
    console.error("[refusals-bot] save:", err.message);
    await reply(msg, "Не вдалося зберегти відмову. Надішли її ще раз за хвилину.");
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!sameSecret(req.headers["x-telegram-bot-api-secret-token"], webhookSecret())) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    await handleUpdate(parseBody(req));
  } catch (err) {
    console.error("[refusals-bot]", err.message);
  }
  // Завжди 200: інакше Telegram повторюватиме те саме оновлення
  return res.status(200).json({ ok: true });
};
