// Двофакторний вхід в адмінку: чиста логіка вибору кроку, без DOM і мережі.
// Звичайний скрипт для браузера (window.StudexMfa) і модуль CommonJS для тестів у node.
// Fail-closed: усе, що не є явно підтвердженим рівнем aal2, веде на підключення або код.
(function () {
  "use strict";

  const LEVEL_VERIFIED = "aal2";
  const FACTOR_TOTP = "totp";
  const STATUS_VERIFIED = "verified";
  const STATUS_UNVERIFIED = "unverified";

  function asList(value) {
    return Array.isArray(value) ? value : [];
  }

  function isTotpWithStatus(factor, status) {
    return Boolean(factor) && factor.factor_type === FACTOR_TOTP && factor.status === status;
  }

  // aal — відповідь getAuthenticatorAssuranceLevel(), factors — відповідь listFactors().
  // Повертає { step: "ok" } | { step: "verify", factorId } | { step: "enroll", staleFactorIds }.
  function mfaStep(aal, factors) {
    if (aal && aal.currentLevel === LEVEL_VERIFIED) return { step: "ok" };

    const list = factors || {};
    // supabase-js кладе в totp лише підтверджені, але тип і статус перевіряємо самі:
    // фактор іншого типу чи непідтверджений не може відкрити крок введення коду.
    const verified = asList(list.totp).find((f) => isTotpWithStatus(f, STATUS_VERIFIED));
    if (verified) return { step: "verify", factorId: verified.id };

    // Непідтверджені TOTP після обірваного підключення прибираються перед новим enroll.
    const staleFactorIds = asList(list.all)
      .filter((f) => isTotpWithStatus(f, STATUS_UNVERIFIED))
      .map((f) => f.id);
    return { step: "enroll", staleFactorIds };
  }

  const api = { mfaStep };
  if (typeof window !== "undefined") window.StudexMfa = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
