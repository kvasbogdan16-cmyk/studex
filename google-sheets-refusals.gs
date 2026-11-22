/** @OnlyCurrentDoc */
// ↑ Google дасть скрипту доступ лише до цієї таблиці, а не до всіх таблиць власника.
//
// Google Таблиця відмов: приймає дані від бота чату відмов (api/refusals-bot.js).
//
// Як підключити:
// 1. Відкрий таблицю → Розширення → Apps Script. Видали все в редакторі й встав цей код.
// 2. Заміни SECRET нижче на довгий випадковий рядок (той самий піде у Vercel як GOOGLE_SHEET_SECRET).
// 3. Розгорнути → Нове розгортання → тип «Веб-застосунок».
//    Виконувати як: «Я». Хто має доступ: «Усі». Розгорнути → дозволити доступ.
// 4. Скопіюй URL веб-застосунку (закінчується на /exec) у Vercel як GOOGLE_SHEET_WEBHOOK_URL.
// 5. Файл → Налаштування → Часовий пояс: (GMT+02:00) Kyiv — щоб час відмов був київським.
//
// Після змін у цьому коді: Розгорнути → Керування розгортаннями → ✏️ → Версія: «Нова версія».
// Так URL лишиться той самий.

const SECRET = "ЗАМІНИ_НА_СВІЙ_СЕКРЕТ";
const SHEET_NAME = "Відмови";
const HEADERS = ["Дата", "Місто", "Причина", "Ім'я", "Телефон", "Коментар", "Хто вніс", "Повідомлення", "Ключ"];
const KEY_COL = HEADERS.length; // службовий стовпець: chat_id:message_id

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ ok: false, error: "bad json" });
  }
  if (!body || body.secret !== SECRET) return reply({ ok: false, error: "forbidden" });

  // Два повідомлення одночасно не повинні записати рядок двічі
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = getSheet();

    // Разове перенесення відмов, зібраних до підключення таблиці
    if (body.action === "saveMany") {
      const rows = body.rows || [];
      rows.forEach(function (r) {
        const k = r.chat_id + ":" + r.message_id;
        writeRow(sheet, findRow(sheet, k) || sheet.getLastRow() + 1, r, k);
      });
      return reply({ ok: true, saved: rows.length });
    }

    const row = body.row || {};
    const key = row.chat_id + ":" + row.message_id;
    const found = findRow(sheet, key);
    if (body.action === "save") {
      const target = found || sheet.getLastRow() + 1;
      writeRow(sheet, target, row, key);
      return reply({ ok: true, updated: Boolean(found) });
    }
    if (body.action === "delete") {
      if (found) sheet.deleteRow(found);
      return reply({ ok: true, deleted: Boolean(found) });
    }
    return reply({ ok: false, error: "unknown action" });
  } finally {
    lock.releaseLock();
  }
}

function getSheet() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = book.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight("bold");
    sheet.setFrozenRows(1);
    sheet.hideColumns(KEY_COL);
  }
  return sheet;
}

function findRow(sheet, key) {
  if (sheet.getLastRow() < 2) return 0;
  const cell = sheet
    .getRange(2, KEY_COL, sheet.getLastRow() - 1, 1)
    .createTextFinder(key)
    .matchEntireCell(true)
    .findNext();
  return cell ? cell.getRow() : 0;
}

function writeRow(sheet, rowIndex, row, key) {
  // Текстові стовпці — простий текст: тоді «+380…» не стане числом, а «=…» — формулою
  sheet.getRange(rowIndex, 2, 1, HEADERS.length - 1).setNumberFormat("@");
  sheet.getRange(rowIndex, 1).setNumberFormat("dd.mm.yyyy hh:mm");
  sheet.getRange(rowIndex, 1, 1, HEADERS.length).setValues([[
    new Date(row.created_at),
    row.city || "",
    row.reason || "",
    row.person || "",
    row.phone || "",
    row.comment || "",
    row.author_name || "",
    messageLink(row),
    key,
  ]]);
}

// Посилання на повідомлення працюють лише в супергрупах (ID починається з -100)
function messageLink(row) {
  const id = String(row.chat_id);
  return id.indexOf("-100") === 0 ? "https://t.me/c/" + id.slice(4) + "/" + row.message_id : "";
}

function reply(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
