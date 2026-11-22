// Копія відмов у Google Таблиці: бот надсилає кожну зміну у веб-застосунок Apps Script
// (код — у google-sheets-refusals.gs). Основна база — Supabase; таблиця — для зручного перегляду.
// Якщо змінні не задані, синхронізація просто вимкнена. Помилки бота лише логуються: відмова
// вже збережена в базі, тож збій таблиці не має заважати менеджерам.
// Файл із «_» на початку Vercel не публікує як окрему функцію.

const { env } = require("./_telegram");

const TIMEOUT_MS = 8000;
const BULK_TIMEOUT_MS = 50000;

function configured() {
  return Boolean(env("GOOGLE_SHEET_WEBHOOK_URL") && env("GOOGLE_SHEET_SECRET"));
}

// Повертає відповідь таблиці або кидає помилку
async function call(payload, timeout) {
  // Apps Script не дає читати заголовки, тому секрет — у тілі запиту
  const res = await fetch(env("GOOGLE_SHEET_WEBHOOK_URL"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: env("GOOGLE_SHEET_SECRET"), ...payload }),
    redirect: "follow",
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Замість JSON Google повертає HTML-сторінку, коли застосунок не опубліковано «для всіх»
  }
  if (!res.ok || !data || !data.ok) {
    throw new Error(`${payload.action}: ${res.status} ${(data && data.error) || text.slice(0, 200)}`);
  }
  return data;
}

async function quietly(payload) {
  if (!configured()) return;
  try {
    await call(payload, TIMEOUT_MS);
  } catch (err) {
    console.error("[sheets]", err.message);
  }
}

// row — те саме, що зберігаємо в базу (chat_id, message_id, city, reason, …, created_at)
function sheetSaveRefusal(row) {
  return quietly({ action: "save", row });
}

function sheetDeleteRefusal(chatId, messageId) {
  return quietly({ action: "delete", row: { chat_id: chatId, message_id: messageId } });
}

// Для разового перенесення: кидає помилку, щоб її було видно
function sheetSaveMany(rows) {
  return call({ action: "saveMany", rows }, BULK_TIMEOUT_MS);
}

module.exports = { configured, sheetSaveRefusal, sheetDeleteRefusal, sheetSaveMany };
