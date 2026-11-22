// POST /api/refusals-bot — вебхук бота чату відмов.
// Telegram надсилає сюди повідомлення з групи й натискання кнопок.
// Відмови за шаблоном зберігаються в базі; /report будує звіт за обраним містом і періодом.
// Запити без правильного X-Telegram-Bot-Api-Secret-Token відкидаються.

const { env, rpc, displayName, sameSecret, parseBody } = require("./_telegram");
const {
  ALL_CITIES, tg, webhookSecret, parseRefusal, normalizeCity, helpText, escapeHtml,
  periodFor, fetchPeriod, recentCities, reportMessages,
  cityFitsButtons, cityTitle, cityKeyboard, cityPromptText, periodKeyboard, periodPromptText, parseCallback,
} = require("./_refusals");

// «/report@studex_bot Київ» → { command: "report", args: "Київ" }
function parseCommand(text) {
  const m = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec((text || "").trim());
  return m ? { command: m[1].toLowerCase(), args: (m[2] || "").trim() } : { command: null, args: "" };
}

// Повідомлення в той самий чат і ту саму гілку (тему), звідки прийшов запит
function threadOf(msg) {
  return msg.is_topic_message ? msg.message_thread_id : undefined;
}

function send(msg, text, extra = {}) {
  return tg("sendMessage", {
    chat_id: msg.chat.id,
    message_thread_id: threadOf(msg),
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

function reply(msg, text, extra = {}) {
  return send(msg, text, { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true }, ...extra });
}

async function edit(msg, text, replyMarkup) {
  try {
    await tg("editMessageText", {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: replyMarkup || { inline_keyboard: [] },
    });
  } catch (err) {
    // Повторне натискання тієї ж кнопки — текст не змінився, це не помилка
    if (!/message is not modified/i.test(err.message)) throw err;
  }
}

async function answer(callback, text) {
  try {
    await tg("answerCallbackQuery", { callback_query_id: callback.id, text: text || undefined });
  } catch (err) {
    // Застаріла кнопка (Telegram чекає відповідь кілька секунд) — не завада
    console.warn("[refusals-bot] answerCallbackQuery:", err.message);
  }
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

// ---------- Відмови ----------

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

  const problems = [];
  if (parsed.missing.length) problems.push(`бракує ${parsed.missing.join(" і ")}`);
  if (parsed.invalid.length) problems.push(`перевір ${parsed.invalid.join(", ")}`);
  if (problems.length) {
    const prefix = edited ? "Зміни не збережено" : "Не можу зберегти відмову";
    await reply(msg, `${prefix}: ${problems.join("; ")}.\n\n${helpText()}`);
    return;
  }

  await rpc("refusals_save", {
    p_chat_id: msg.chat.id,
    p_message_id: msg.message_id,
    p_city: parsed.city,
    p_reason: parsed.reason,
    p_person: parsed.person,
    p_phone: parsed.phone,
    p_comment: parsed.comment,
    p_author_id: msg.from.id,
    p_author_name: displayName(msg.from),
    p_created_at: new Date(msg.date * 1000).toISOString(),
  });
  await react(msg.chat.id, msg.message_id, "👍");
}

// ---------- Звіти на вимогу ----------

// /report — кнопки з містами; /report Київ — одразу кнопки з періодами
async function handleReportCommand(msg, args) {
  if (args) {
    const city = normalizeCity(args);
    if (!city || !cityFitsButtons(city)) {
      await reply(msg, "Не впізнав місто. Напиши /report і обери місто кнопкою або так: /report Київ");
      return;
    }
    await send(msg, periodPromptText(city), { reply_markup: periodKeyboard(city) });
    return;
  }
  const cities = await recentCities();
  await send(msg, cityPromptText(cities), { reply_markup: cityKeyboard(cities) });
}

async function sendReport(msg, city, code) {
  const period = periodFor(code);
  await edit(msg, `📊 Звіт по відмовах: <b>${escapeHtml(cityTitle(city))}</b>, ${escapeHtml(period.title)} 👇`);
  try {
    const { rows, prevRows } = await fetchPeriod(period);
    for (const text of reportMessages(city, period, rows, prevRows)) await send(msg, text);
  } catch (err) {
    console.error("[refusals-bot] report:", err.message);
    await send(msg, "Не вдалося сформувати звіт. Спробуй ще раз: /report");
  }
}

async function handleCallback(callback) {
  const msg = callback.message;
  if (!msg || !msg.chat || String(msg.chat.id) !== env("REFUSALS_CHAT_ID")) {
    await answer(callback, "Звіти доступні лише в чаті відмов.");
    return;
  }

  const action = parseCallback(callback.data);
  if (!action) {
    await answer(callback);
    return;
  }

  if (action.action === "back") {
    await answer(callback);
    const cities = await recentCities();
    await edit(msg, cityPromptText(cities), cityKeyboard(cities));
  } else if (action.action === "city") {
    await answer(callback);
    await edit(msg, periodPromptText(action.city), periodKeyboard(action.city));
  } else if (action.action === "period") {
    // Відповідаємо одразу: Telegram показує годинник на кнопці, доки не отримає відповідь
    await answer(callback, "Формую звіт…");
    await sendReport(msg, action.city, action.code);
  }
}

// ---------- Вебхук ----------

async function handleMessage(update) {
  const edited = Boolean(update.edited_message);
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat || !msg.from || msg.from.is_bot) return;

  const { command, args } = parseCommand(msg.text || msg.caption || "");
  const chatId = String(msg.chat.id);
  const ownChat = chatId === env("REFUSALS_CHAT_ID");

  if (command === "help" || command === "start") {
    if (edited) return;
    // Поки чат не налаштований, підказуємо його ID — без нього бот не знає, де працювати
    const setup = ownChat ? "" : `\n\nID цього чату: <code>${chatId}</code>. Додай його у Vercel як REFUSALS_CHAT_ID, якщо це чат відмов.`;
    await reply(msg, helpText() + setup);
    return;
  }

  // Відмови і звіти — лише в одному чаті
  if (!ownChat) return;

  if (command === "undo") {
    if (!edited) await handleUndo(msg);
    return;
  }
  if (command === "report") {
    if (edited) return;
    try {
      await handleReportCommand(msg, args);
    } catch (err) {
      console.error("[refusals-bot] /report:", err.message);
      await reply(msg, "Не вдалося отримати список міст. Спробуй ще раз за хвилину.");
    }
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

async function handleUpdate(update) {
  if (update.callback_query) {
    if (!update.callback_query.from || update.callback_query.from.is_bot) return;
    await handleCallback(update.callback_query);
    return;
  }
  await handleMessage(update);
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

module.exports.handleUpdate = handleUpdate;
module.exports.parseCommand = parseCommand;
