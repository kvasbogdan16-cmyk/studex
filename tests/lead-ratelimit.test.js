// /api/lead: ліміт заявок (тригер у базі, supabase-ratelimit.sql), пастка для ботів і лише JSON.
// Мережа підмінена: fetch нікуди не ходить, а записує, куди його кликали.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const handler = require("../api/lead");

const SUPABASE_URL = "https://example.supabase.co";
const realFetch = globalThis.fetch;
const savedEnv = {};
const ENV = {
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
  TELEGRAM_BOT_TOKEN: "test-bot-token",
  TELEGRAM_CHAT_ID: "12345",
};

let calls;

// supabase: { status, body } — що відповідає Supabase на вставку заявки
function mockFetch(supabase) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith(SUPABASE_URL)) {
      calls.supabase++;
      return {
        ok: supabase.status >= 200 && supabase.status < 300,
        status: supabase.status,
        text: async () => supabase.body,
      };
    }
    if (u.startsWith("https://api.telegram.org/")) {
      calls.telegram++;
      return { json: async () => ({ ok: true }) };
    }
    throw new Error("unexpected fetch: " + u);
  };
}

function request(body, contentType = "application/json") {
  return { method: "POST", headers: { "content-type": contentType }, body };
}

function response() {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (obj) => ((res.body = obj), res);
  res.setHeader = (k, v) => (res.headers[k] = v);
  return res;
}

const validLead = { name: "Тест", phone: "+380671234567", comment: "", hp: "" };

beforeEach(() => {
  calls = { supabase: 0, telegram: 0 };
  for (const [k, v] of Object.entries(ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("ліміт бази (too_many_requests) → 429 з текстом, без сповіщення в Telegram", async () => {
  mockFetch({
    status: 400,
    body: '{"code":"P0001","details":null,"hint":"site_phone_limit","message":"too_many_requests"}',
  });
  const res = response();
  await handler(request({ ...validLead }), res);

  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error, "Забагато заявок. Спробуй пізніше.");
  assert.equal(calls.supabase, 1);
  assert.equal(calls.telegram, 0);
});

test("інша помилка Supabase → 502, як і раніше", async () => {
  mockFetch({ status: 500, body: '{"message":"internal error"}' });
  const res = response();
  await handler(request({ ...validLead }), res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "Не вдалося зберегти заявку");
  assert.equal(calls.telegram, 0);
});

test("успішна заявка → 200 і рівно одне сповіщення в Telegram", async () => {
  mockFetch({ status: 201, body: "" });
  const res = response();
  await handler(request({ ...validLead }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.telegram, "sent");
  assert.equal(calls.supabase, 1);
  assert.equal(calls.telegram, 1);
});

test("заповнена пастка для ботів → 200, але нічого не зберігається і не надсилається", async () => {
  mockFetch({ status: 201, body: "" });
  const res = response();
  await handler(request({ ...validLead, hp: "http://spam.example" }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(calls.supabase, 0);
  assert.equal(calls.telegram, 0);
});

test("не-JSON запит (форма з чужого сайту) → 415 без звернення до бази", async () => {
  mockFetch({ status: 201, body: "" });
  const res = response();
  await handler(request("name=Bot&phone=380671234567", "application/x-www-form-urlencoded"), res);

  assert.equal(res.statusCode, 415);
  assert.equal(calls.supabase, 0);
  assert.equal(calls.telegram, 0);
});
