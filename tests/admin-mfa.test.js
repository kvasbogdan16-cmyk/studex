// admin-mfa.js: вибір кроку 2FA в адмінці за рівнем входу і списком факторів.
// Форма даних — як у supabase-js@2.117.3: listFactors() → { all, totp (лише підтверджені), phone },
// getAuthenticatorAssuranceLevel() → { currentLevel, nextLevel }.
// Головне правило: будь-які неповні дані дають "enroll", а не "ok" (fail-closed).
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { mfaStep } = require("../admin-mfa.js");

const AAL1 = { currentLevel: "aal1", nextLevel: "aal1" };
const AAL1_NEXT_AAL2 = { currentLevel: "aal1", nextLevel: "aal2" };
const AAL2 = { currentLevel: "aal2", nextLevel: "aal2" };

function factor(id, factorType, status) {
  return { id, factor_type: factorType, status };
}

// Будує відповідь listFactors так само, як supabase-js: totp — лише підтверджені TOTP.
function factorList(...factors) {
  return {
    all: factors,
    totp: factors.filter((f) => f.factor_type === "totp" && f.status === "verified"),
    phone: factors.filter((f) => f.factor_type === "phone" && f.status === "verified"),
  };
}

test("aal2 → ok, навіть без списку факторів", () => {
  assert.deepEqual(mfaStep(AAL2, null), { step: "ok" });
  assert.deepEqual(mfaStep({ currentLevel: "aal2" }, undefined), { step: "ok" });
  assert.deepEqual(mfaStep(AAL2, factorList(factor("f1", "totp", "verified"))), { step: "ok" });
});

test("aal1 + підтверджений TOTP → verify з id цього фактора", () => {
  const factors = factorList(factor("f1", "totp", "verified"));
  assert.deepEqual(mfaStep(AAL1_NEXT_AAL2, factors), { step: "verify", factorId: "f1" });
});

test("aal1 + підтверджений TOTP → verify, навіть коли nextLevel теж aal1", () => {
  const factors = factorList(factor("f1", "totp", "verified"));
  assert.deepEqual(mfaStep(AAL1, factors), { step: "verify", factorId: "f1" });
});

test("кілька підтверджених TOTP → завжди перший", () => {
  const factors = factorList(
    factor("unv", "totp", "unverified"),
    factor("first", "totp", "verified"),
    factor("second", "totp", "verified")
  );
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(mfaStep(AAL1_NEXT_AAL2, factors), { step: "verify", factorId: "first" });
  }
});

test("фактор не TOTP ніколи не повертається як verify", () => {
  const phone = factor("p1", "phone", "verified");
  assert.deepEqual(mfaStep(AAL1_NEXT_AAL2, factorList(phone)), { step: "enroll", staleFactorIds: [] });

  // Навіть якщо телефон якось потрапив у totp[] — його відкидає перевірка factor_type.
  const forged = { all: [phone], totp: [phone], phone: [phone] };
  assert.deepEqual(mfaStep(AAL1_NEXT_AAL2, forged), { step: "enroll", staleFactorIds: [] });

  // Телефон першим у totp[], справжній TOTP другим → обирається TOTP.
  const totp = factor("t1", "totp", "verified");
  const mixed = { all: [phone, totp], totp: [phone, totp], phone: [phone] };
  assert.deepEqual(mfaStep(AAL1_NEXT_AAL2, mixed), { step: "verify", factorId: "t1" });
});

test("непідтверджений TOTP у totp[] не дає verify", () => {
  const unverified = factor("u1", "totp", "unverified");
  const forged = { all: [unverified], totp: [unverified], phone: [] };
  assert.deepEqual(mfaStep(AAL1, forged), { step: "enroll", staleFactorIds: ["u1"] });
});

test("aal1 без факторів → enroll з порожнім списком для прибирання", () => {
  assert.deepEqual(mfaStep(AAL1, factorList()), { step: "enroll", staleFactorIds: [] });
});

test("aal1 + лише непідтверджений TOTP → enroll + його id для прибирання", () => {
  const factors = factorList(factor("u1", "totp", "unverified"));
  assert.deepEqual(mfaStep(AAL1, factors), { step: "enroll", staleFactorIds: ["u1"] });
});

test("прибираються лише непідтверджені TOTP, не телефони", () => {
  const factors = factorList(
    factor("u1", "totp", "unverified"),
    factor("p1", "phone", "unverified"),
    factor("u2", "totp", "unverified")
  );
  assert.deepEqual(mfaStep(AAL1, factors), { step: "enroll", staleFactorIds: ["u1", "u2"] });
});

test("порожні або відсутні дані → enroll, ніколи не ok (fail-closed)", () => {
  const empties = [null, undefined, {}];
  for (const aal of empties) {
    for (const factors of empties) {
      assert.deepEqual(mfaStep(aal, factors), { step: "enroll", staleFactorIds: [] });
    }
  }
  assert.deepEqual(mfaStep(), { step: "enroll", staleFactorIds: [] });
  assert.deepEqual(mfaStep(AAL1, null), { step: "enroll", staleFactorIds: [] });
  assert.deepEqual(mfaStep(null, factorList()), { step: "enroll", staleFactorIds: [] });
});

test("невідомий рівень або aal2 лише в nextLevel → не ok", () => {
  assert.equal(mfaStep({ currentLevel: "AAL2" }, factorList()).step, "enroll");
  assert.equal(mfaStep({ currentLevel: null, nextLevel: "aal2" }, factorList()).step, "enroll");
  assert.equal(mfaStep({ nextLevel: "aal2" }, null).step, "enroll");
});

test("пошкоджені поля списку (не масиви, null-елементи) → enroll, без винятків", () => {
  assert.deepEqual(mfaStep(AAL1, { all: "x", totp: {} }), { step: "enroll", staleFactorIds: [] });
  assert.deepEqual(mfaStep(AAL1, { all: [null], totp: [null] }), { step: "enroll", staleFactorIds: [] });
});

test("модуль вантажиться в node без window і не чіпає глобальний простір", () => {
  assert.equal(typeof globalThis.window, "undefined");
  assert.equal(typeof mfaStep, "function");
  assert.equal(globalThis.StudexMfa, undefined);
});
