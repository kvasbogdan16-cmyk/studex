// Звіти чату відмов: кожне повідомлення має бути коректним HTML для Telegram (parse_mode: HTML).
// Аудит безпеки, R1: довгий коментар із «&» після екранування перевищував ліміт рядка,
// обрізка розрізала сутність (&am…) і відкидала </i> — Telegram відхиляв увесь звіт по місту.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { reportMessages, periodFor, LVIV, ALL_CITIES } = require("../api/_refusals");

const TELEGRAM_LIMIT = 4096;
const NOW = new Date("2026-11-24T12:00:00Z");

function row(fields = {}) {
  return {
    city: LVIV,
    reason: "Знайшов іншу роботу",
    person: "Олена",
    phone: "+380671234567",
    comment: "",
    author_name: "Менеджер",
    created_at: "2026-11-23T10:00:00Z",
    chat_id: -1001234567890,
    message_id: 42,
    ...fields,
  };
}

// Перевірка, яку робить Telegram: сутності цілі, теги закриті й вкладені правильно, без «голих» < >
function assertTelegramHtml(message) {
  assert.ok(message.length <= TELEGRAM_LIMIT, `повідомлення довше за ${TELEGRAM_LIMIT}: ${message.length}`);

  const withoutEntities = message.replace(/&(amp|lt|gt|quot);/g, "");
  assert.ok(!withoutEntities.includes("&"), "розірвана HTML-сутність (& без ;)");

  const stack = [];
  const text = message.replace(/<(\/?)([a-z]+)(?:\s[^<>]*)?>/g, (_, closing, tag) => {
    assert.ok(["b", "i", "a"].includes(tag), `неочікуваний тег <${tag}>`);
    if (closing) assert.equal(stack.pop(), tag, `</${tag}> без відповідного відкриття`);
    else stack.push(tag);
    return "";
  });
  assert.deepEqual(stack, [], `не закриті теги: ${stack.join(", ")}`);
  assert.ok(!/[<>]/.test(text), "«голий» < або > у тексті");
}

function cityReport(rows) {
  return reportMessages(LVIV, periodFor("lw", NOW), rows, []);
}

test("коментар із 1000 «&» не ламає HTML детального звіту по місту", () => {
  const messages = cityReport([row({ comment: "&".repeat(1000) })]);
  assert.ok(messages.length > 0);
  messages.forEach(assertTelegramHtml);
});

test("причина й коментар із «<» та «>» на максимальну довжину не ламають HTML", () => {
  const messages = cityReport([row({ reason: "<".repeat(200), comment: ">".repeat(1000), person: "&".repeat(100) })]);
  messages.forEach(assertTelegramHtml);
});

test("багато довгих відмов ділиться на кілька коректних повідомлень", () => {
  const rows = Array.from({ length: 30 }, (_, i) => row({ comment: `#${i} ` + "&<>".repeat(300), message_id: i + 1 }));
  const messages = cityReport(rows);
  assert.ok(messages.length > 1, "очікували кілька повідомлень");
  messages.forEach(assertTelegramHtml);
});

test("звичайний короткий коментар лишається в звіті повністю, курсивом", () => {
  const messages = cityReport([row({ comment: "Пропонують «більше» & швидше" })]);
  const text = messages.join("\n");
  assert.ok(text.includes("<i>Пропонують «більше» &amp; швидше</i>"));
  messages.forEach(assertTelegramHtml);
});

test("загальний звіт по всіх містах теж коректний HTML", () => {
  const messages = reportMessages(ALL_CITIES, periodFor("lw", NOW), [row({ reason: "&".repeat(200), city: "&<Київ>" })], []);
  messages.forEach(assertTelegramHtml);
});
