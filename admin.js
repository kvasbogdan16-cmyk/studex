// Адмін-панель: вхід, воронка заявок, ручне додавання клієнта, історія переходів
// Адреса і ключ Supabase приходять із /api/config (налаштування Vercel), у коді їх немає.
let db;

const views = {
  loading: document.getElementById("view-loading"),
  login: document.getElementById("view-login"),
  mfa: document.getElementById("view-mfa"),
  leads: document.getElementById("view-leads"),
  images: document.getElementById("view-images"),
};
const adminNav = document.getElementById("admin-nav");

const userBox = document.getElementById("user-box");
const userEmail = document.getElementById("user-email");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const loginSubmit = document.getElementById("login-submit");

const mfaEnroll = document.getElementById("mfa-enroll");
const mfaVerify = document.getElementById("mfa-verify");
const mfaForm = document.getElementById("mfa-form");
const mfaCode = document.getElementById("mfa-code");
const mfaSubmit = document.getElementById("mfa-submit");
const mfaError = document.getElementById("mfa-error");
const mfaQr = document.getElementById("mfa-qr");
const mfaSecret = document.getElementById("mfa-secret");
const board = document.getElementById("board");
const leadsError = document.getElementById("leads-error");
const leadsSummary = document.getElementById("leads-summary");
const columnTemplate = document.getElementById("column-template");
const leadTemplate = document.getElementById("lead-template");
const toast = document.getElementById("toast");

const addDialog = document.getElementById("add-dialog");
const addForm = document.getElementById("add-form");
const addError = document.getElementById("add-error");
const addSubmit = document.getElementById("add-submit");
const addStage = document.getElementById("add-stage");

const LEAD_FIELDS =
  "id, created_at, name, phone, comment, source, stage_id, company, job_title, email, document_path, telegram_username";
const HISTORY_FIELDS = "id, lead_id, from_stage_id, to_stage_id, changed_at";

const dateFormat = new Intl.DateTimeFormat("uk-UA", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

// Коротший формат для історії: «15 лист. 2026 р. о 17:12»
const historyDateFormat = new Intl.DateTimeFormat("uk-UA", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

let stages = []; // [{ id, name, position, is_lost }]
let leads = []; // [{ id, created_at, name, phone, comment, source, stage_id }]
let historyByLead = new Map(); // lead_id → [{ from_stage_id, to_stage_id, changed_at }]
const openHistory = new Set(); // id карток із розгорнутою історією

function show(view) {
  Object.entries(views).forEach(([name, el]) => (el.hidden = name !== view));
  adminNav.hidden = view !== "leads" && view !== "images";
  adminNav.querySelectorAll("[data-view]").forEach((btn) => {
    const active = btn.dataset.view === view;
    btn.classList.toggle("is-active", active);
    if (active) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
}

adminNav.querySelectorAll("[data-view]").forEach((btn) =>
  btn.addEventListener("click", () => {
    show(btn.dataset.view);
    if (btn.dataset.view === "images") loadImages();
  })
);

let toastTimer;
function notify(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 2600);
}

// ----- Вхід і вихід -----

async function openPanel(session) {
  // Спершу другий фактор: без сесії aal2 воронку не відкриваємо взагалі.
  if (!(await ensureMfa())) return;

  userEmail.textContent = session.user.email;
  userBox.hidden = false;

  const { data: isAdmin, error } = await db.rpc("is_admin");
  if (error || !isAdmin) {
    await db.auth.signOut();
    showLogin("У цього акаунта немає доступу до адмін-панелі.");
    return;
  }

  show("leads");
  loadBoard();
}

function showLogin(message = "") {
  userBox.hidden = true;
  leads = [];
  historyByLead = new Map();
  board.replaceChildren();
  clearMfa();
  loginError.textContent = message;
  show("login");
}

async function logout() {
  await db.auth.signOut();
  showLogin();
}

// ----- Двофакторний вхід (TOTP) -----
// Вибір кроку — чиста функція StudexMfa.mfaStep (admin-mfa.js). Будь-яка помилка тут
// лишає людину на екрані 2FA: ensureMfa повертає true лише для сесії aal2.

const MFA_FACTOR_NAME = "Studex admin";
const MFA_CODE_PATTERN = /^[0-9]{6}$/;
const MFA_QR_PREFIX = "data:image/";
const HTTP_TOO_MANY_REQUESTS = 429;
const MFA_MESSAGES = {
  unavailable: "Не вдалося перевірити двофакторний вхід. Онови сторінку або спробуй пізніше.",
  badFormat: "Введи 6 цифр коду.",
  wrongCode: "Невірний або прострочений код. Спробуй ще раз.",
  tooManyAttempts: "Забагато спроб. Зачекай хвилину.",
  sessionLost: "Сесія завершилась. Увійди ще раз.",
};

let mfaFactorId = null;

function clearMfa() {
  mfaFactorId = null;
  mfaQr.removeAttribute("src");
  mfaSecret.textContent = "";
  mfaCode.value = "";
  mfaError.textContent = "";
}

// mode: "enroll" | "verify" | "error" — у режимі помилки форми коду немає, лише текст і «Вийти».
function showMfa(mode, message = "") {
  mfaEnroll.hidden = mode !== "enroll";
  mfaVerify.hidden = mode !== "verify";
  mfaForm.hidden = mode === "error";
  mfaCode.value = "";
  mfaError.textContent = message;
  show("mfa");
  if (mode !== "error") mfaCode.focus();
}

function failMfa(err) {
  console.error(err);
  clearMfa();
  showMfa("error", MFA_MESSAGES.unavailable);
  return false;
}

async function ensureMfa() {
  try {
    const [aalRes, factorsRes] = await Promise.all([
      db.auth.mfa.getAuthenticatorAssuranceLevel(),
      db.auth.mfa.listFactors(),
    ]);
    if (aalRes.error || factorsRes.error) return failMfa(aalRes.error || factorsRes.error);

    const next = window.StudexMfa.mfaStep(aalRes.data, factorsRes.data);
    if (next.step === "ok") return true;
    if (next.step === "verify") {
      clearMfa();
      mfaFactorId = next.factorId;
      showMfa("verify");
      return false;
    }
    if (next.step === "enroll") return await enrollMfa(next.staleFactorIds);
    return failMfa(new Error(`Unknown MFA step: ${next.step}`));
  } catch (err) {
    return failMfa(err);
  }
}

// Прибирає непідтверджені фактори від обірваних спроб і показує новий QR-код.
// Завжди повертає false: панель відкриється лише після введення коду.
async function enrollMfa(staleFactorIds) {
  for (const factorId of staleFactorIds) {
    const { error } = await db.auth.mfa.unenroll({ factorId });
    if (error) return failMfa(error);
  }

  const { data, error } = await db.auth.mfa.enroll({ factorType: "totp", friendlyName: MFA_FACTOR_NAME });
  if (error) return failMfa(error);
  if (!isUsableEnrollment(data)) return failMfa(new Error("mfa.enroll returned an unexpected response"));

  mfaFactorId = data.id;
  mfaQr.src = data.totp.qr_code;
  mfaSecret.textContent = data.totp.secret;
  showMfa("enroll");
  return false;
}

// QR приймаємо лише як data:-картинку від supabase-js, ніколи як зовнішню адресу.
function isUsableEnrollment(data) {
  const totp = data && data.totp;
  return Boolean(
    totp && data.id && totp.secret && typeof totp.qr_code === "string" && totp.qr_code.startsWith(MFA_QR_PREFIX)
  );
}

function mfaVerifyErrorMessage(error) {
  return error.status === HTTP_TOO_MANY_REQUESTS ? MFA_MESSAGES.tooManyAttempts : MFA_MESSAGES.wrongCode;
}

mfaForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = mfaCode.value.trim();
  if (!MFA_CODE_PATTERN.test(code)) {
    mfaError.textContent = MFA_MESSAGES.badFormat;
    return;
  }
  if (!mfaFactorId) {
    mfaError.textContent = MFA_MESSAGES.unavailable;
    return;
  }

  mfaSubmit.disabled = true;
  mfaError.textContent = "";
  try {
    const { error } = await db.auth.mfa.challengeAndVerify({ factorId: mfaFactorId, code });
    if (error) {
      console.error(error);
      mfaError.textContent = mfaVerifyErrorMessage(error);
      mfaCode.value = "";
      mfaCode.focus();
      return;
    }

    const { data, error: sessionError } = await db.auth.getSession();
    if (sessionError || !data.session) {
      if (sessionError) console.error(sessionError);
      showLogin(MFA_MESSAGES.sessionLost);
      return;
    }
    clearMfa();
    await openPanel(data.session);
  } catch (err) {
    console.error(err);
    mfaError.textContent = MFA_MESSAGES.unavailable;
  } finally {
    mfaSubmit.disabled = false;
  }
});

document.getElementById("mfa-copy").addEventListener("click", async () => {
  const secret = mfaSecret.textContent;
  if (!secret) return;
  try {
    await navigator.clipboard.writeText(secret);
    notify("Секрет скопійовано.");
  } catch (err) {
    console.error(err);
    notify("Не вдалося скопіювати. Виділи секрет і скопіюй вручну.", true);
  }
});

document.getElementById("mfa-logout").addEventListener("click", logout);

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = loginForm.elements.email.value.trim();
  const password = loginForm.elements.password.value;

  if (!email || !password) {
    loginError.textContent = "Введи email і пароль.";
    return;
  }

  loginSubmit.disabled = true;
  loginSubmit.textContent = "Входимо…";
  loginError.textContent = "";

  const { data, error } = await db.auth.signInWithPassword({ email, password });

  loginSubmit.disabled = false;
  loginSubmit.textContent = "Увійти";

  if (error) {
    loginError.textContent = /invalid login credentials/i.test(error.message)
      ? "Неправильний email або пароль."
      : /email not confirmed/i.test(error.message)
        ? "Email ще не підтверджено."
        : "Не вдалося увійти. Спробуй ще раз.";
    return;
  }

  loginForm.reset();
  openPanel(data.session);
});

document.getElementById("logout").addEventListener("click", logout);

// ----- Дані -----

async function loadBoard() {
  leadsError.textContent = "";
  const [stagesRes, leadsRes, historyRes] = await Promise.all([
    db.from("lead_stages").select("id, name, position, is_lost").order("position"),
    db.from("leads").select(LEAD_FIELDS).order("created_at", { ascending: false }),
    db.from("lead_history").select(HISTORY_FIELDS).order("changed_at").order("id"),
  ]);

  const error = stagesRes.error || leadsRes.error || historyRes.error;
  if (error) {
    console.error(error);
    leadsError.textContent = "Не вдалося завантажити воронку. Онови сторінку.";
    return;
  }

  stages = stagesRes.data;
  leads = leadsRes.data;
  historyByLead = new Map();
  historyRes.data.forEach(addHistoryRow);
  fillStageSelect(addStage);
  render();
}

function addHistoryRow(row) {
  if (!historyByLead.has(row.lead_id)) historyByLead.set(row.lead_id, []);
  historyByLead.get(row.lead_id).push(row);
}

async function reloadHistory(leadId) {
  const { data, error } = await db
    .from("lead_history")
    .select(HISTORY_FIELDS)
    .eq("lead_id", leadId)
    .order("changed_at")
    .order("id");
  if (error) {
    console.error(error);
    return;
  }
  historyByLead.set(leadId, data);
}

const stageById = (id) => stages.find((s) => s.id === id);
const stageName = (id) => (stageById(id) ? stageById(id).name : "—");

// Вид етапу для кольору: перший, проміжний, успіх (останній перед «Відмовою»), відмова
function stageKind(stage) {
  if (!stage) return "progress";
  if (stage.is_lost) return "lost";
  const active = stages.filter((s) => !s.is_lost);
  if (stage.id === active[0].id) return "new";
  if (stage.id === active[active.length - 1].id) return "won";
  return "progress";
}

function fillStageSelect(select, selectedId) {
  select.replaceChildren(
    ...stages.map((s) => {
      const option = new Option(s.name, s.id);
      option.selected = s.id === selectedId;
      return option;
    })
  );
}

// ----- Відображення -----

function render() {
  const count = (kind) => leads.filter((l) => stageKind(stageById(l.stage_id)) === kind).length;
  const won = count("won");
  const lost = count("lost");
  leadsSummary.textContent = leads.length
    ? `Усього ${leads.length} · у роботі ${leads.length - won - lost} · успішно ${won} · відмов ${lost}. Перетягни картку або обери етап на ній.`
    : "Заявок поки немає. Заявки з сайту з'являться в першій колонці.";

  const scrollLeft = board.scrollLeft;
  board.replaceChildren(...stages.map(renderColumn));
  board.scrollLeft = scrollLeft;
}

function renderColumn(stage) {
  const column = columnTemplate.content.firstElementChild.cloneNode(true);
  const items = leads.filter((l) => l.stage_id === stage.id);

  column.dataset.stageId = stage.id;
  column.dataset.kind = stageKind(stage);
  column.querySelector(".column__title").textContent = stage.name;
  column.querySelector(".column__count").textContent = items.length;
  column.querySelector(".column__list").replaceChildren(...items.map(renderLead));
  column.querySelector(".column__empty").hidden = items.length > 0;

  column.addEventListener("dragover", (e) => {
    if (!dragged) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    column.classList.add("is-drop");
  });
  column.addEventListener("dragleave", (e) => {
    if (!column.contains(e.relatedTarget)) column.classList.remove("is-drop");
  });
  column.addEventListener("drop", (e) => {
    e.preventDefault();
    column.classList.remove("is-drop");
    if (dragged && dragged.stage_id !== stage.id) changeStage(dragged, stage.id);
  });

  return column;
}

let dragged = null;

function renderLead(lead) {
  const card = leadTemplate.content.firstElementChild.cloneNode(true);
  const stage = stageById(lead.stage_id);
  card.dataset.kind = stageKind(stage);
  card.dataset.id = lead.id;
  card.draggable = true;

  card.querySelector(".lead__name").textContent = lead.name;

  const source = card.querySelector(".lead__source");
  source.textContent = lead.source;
  source.dataset.source = lead.source;

  const time = card.querySelector(".lead__date");
  time.dateTime = lead.created_at;
  time.textContent = dateFormat.format(new Date(lead.created_at));

  card.querySelector(".lead__company").textContent = [lead.job_title, lead.company].filter(Boolean).join(" · ");

  const phone = card.querySelector(".lead__phone");
  phone.textContent = lead.phone;
  phone.href = "tel:" + lead.phone.replace(/[^\d+]/g, "");

  const email = card.querySelector(".lead__email");
  if (lead.email) {
    email.textContent = lead.email;
    email.href = "mailto:" + lead.email;
    email.hidden = false;
  }

  const telegram = card.querySelector(".lead__telegram");
  if (lead.telegram_username) {
    telegram.textContent = "✈️ @" + lead.telegram_username;
    telegram.href = "https://t.me/" + encodeURIComponent(lead.telegram_username);
    telegram.hidden = false;
  }

  card.querySelector(".lead__comment").textContent = lead.comment || "";

  const doc = card.querySelector(".lead__doc");
  if (lead.document_path) {
    doc.hidden = false;
    doc.addEventListener("click", () => openDocument(lead, card));
  }

  const select = card.querySelector("select");
  fillStageSelect(select, lead.stage_id);
  select.addEventListener("change", () => changeStage(lead, Number(select.value), select));

  const history = historyByLead.get(lead.id) || [];
  const details = card.querySelector(".lead__history");
  details.querySelector("summary").textContent = `Історія · ${history.length}`;
  details.querySelector(".history").replaceChildren(...history.map(renderHistoryRow));
  details.open = openHistory.has(lead.id);
  details.addEventListener("toggle", () => {
    if (details.open) openHistory.add(lead.id);
    else openHistory.delete(lead.id);
  });

  card.addEventListener("dragstart", (e) => {
    dragged = lead;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(lead.id));
    requestAnimationFrame(() => card.classList.add("is-dragging"));
  });
  card.addEventListener("dragend", () => {
    dragged = null;
    card.classList.remove("is-dragging");
    board.querySelectorAll(".is-drop").forEach((c) => c.classList.remove("is-drop"));
  });

  return card;
}

function renderHistoryRow(row) {
  const li = document.createElement("li");
  li.className = "history__item";

  const time = document.createElement("time");
  time.dateTime = row.changed_at;
  time.textContent = historyDateFormat.format(new Date(row.changed_at));

  const text = document.createElement("span");
  text.textContent =
    row.from_stage_id === null
      ? `Створено → ${stageName(row.to_stage_id)}`
      : `${stageName(row.from_stage_id)} → ${stageName(row.to_stage_id)}`;

  li.append(time, text);
  return li;
}

// ----- Зміна етапу -----

async function changeStage(lead, nextId, select) {
  const previousId = lead.stage_id;
  if (nextId === previousId) return;
  if (select) select.disabled = true;

  // Одразу показуємо картку на новому місці; якщо база відмовить — повертаємо назад
  lead.stage_id = nextId;
  render();

  const { data, error } = await db
    .from("leads")
    .update({ stage_id: nextId })
    .eq("id", lead.id)
    .select("id");

  if (error || !data || data.length === 0) {
    console.error(error);
    lead.stage_id = previousId;
    render();
    notify("Не вдалося змінити етап", true);
    return;
  }

  await reloadHistory(lead.id);
  render();
  notify(`«${lead.name}»: ${stageName(nextId)}`);
}

// ----- Новий клієнт -----

function validateClient(form) {
  const name = form.elements.name.value.trim();
  const phone = form.elements.phone.value.trim();
  const comment = form.elements.comment.value.trim();
  const digits = phone.replace(/\D/g, "");

  if (name.length < 2) return { error: "Вкажи ім'я (від 2 символів).", field: "name" };
  if (digits.length < 10 || digits.length > 13) return { error: "Перевір номер телефону: потрібно 10–13 цифр.", field: "phone" };
  return {
    client: {
      name,
      phone,
      comment: comment || null,
      source: "Вручну",
      stage_id: form.elements.stage ? Number(form.elements.stage.value) : stages[0].id,
    },
  };
}

document.getElementById("add-open").addEventListener("click", () => {
  addForm.reset();
  addError.textContent = "";
  fillStageSelect(addStage, stages[0] && stages[0].id);
  addDialog.showModal();
  addForm.elements.name.focus();
});

document.getElementById("add-close").addEventListener("click", () => addDialog.close());

addDialog.addEventListener("click", (e) => {
  if (e.target === addDialog) addDialog.close(); // клік по затемненню
});

addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const { client, error, field } = validateClient(addForm);
  if (error) {
    addError.textContent = error;
    addForm.elements[field].focus();
    return;
  }

  addSubmit.disabled = true;
  addSubmit.textContent = "Додаємо…";
  addError.textContent = "";

  const { data, error: dbError } = await db.from("leads").insert(client).select(LEAD_FIELDS).single();

  addSubmit.disabled = false;
  addSubmit.textContent = "Додати у воронку";

  if (dbError) {
    console.error(dbError);
    addError.textContent = "Не вдалося додати клієнта. Спробуй ще раз.";
    return;
  }

  leads.unshift(data);
  await reloadHistory(data.id);
  addDialog.close();
  render();
  notify(`«${data.name}» додано: ${stageName(data.stage_id)}`);
});

document.getElementById("refresh").addEventListener("click", loadBoard);

// ----- Візитка: розпізнавання через Claude -----

const MAX_ORIGINAL_BYTES = 15 * 1024 * 1024; // ліміт сховища scans
const MAX_PDF_BYTES = 3 * 1024 * 1024; // PDF іде в Claude як є
const CLAUDE_IMAGE_SIDE = 1600; // фото для Claude зменшуємо: швидше і дешевше, текст лишається чітким

const scanDialog = document.getElementById("scan-dialog");
const scanFile = document.getElementById("scan-file");
const scanPreview = document.getElementById("scan-preview");
const scanLoading = document.getElementById("scan-loading");
const scanFail = document.getElementById("scan-fail");
const scanFailText = document.getElementById("scan-fail-text");
const scanForm = document.getElementById("scan-form");
const scanError = document.getElementById("scan-error");
const scanSubmit = document.getElementById("scan-submit");

let scanOriginal = null; // файл, який обрав адмін (зберігаємо як оригінал)
let scanRun = 0; // щоб відповідь старого розпізнавання не перезаписала нове
let previewUrl = null;

function setScanState(state, message = "") {
  scanLoading.hidden = state !== "loading";
  scanFail.hidden = state !== "fail";
  scanForm.hidden = state !== "review";
  scanFailText.textContent = message;
}

function showPreview(file) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  if (file.type.startsWith("image/")) {
    previewUrl = URL.createObjectURL(file);
    const img = new Image();
    img.src = previewUrl;
    img.alt = "Фото візитки";
    scanPreview.replaceChildren(img);
  } else {
    const p = document.createElement("p");
    p.className = "scan-preview__file";
    p.textContent = "📄 " + file.name;
    scanPreview.replaceChildren(p);
  }
}

function fileToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Готує файл для Claude: фото зменшує до JPEG, PDF надсилає як є
async function prepareForClaude(file) {
  if (file.type === "application/pdf") {
    if (file.size > MAX_PDF_BYTES) throw new Error("PDF завеликий: до 3 МБ. Сфотографуй візитку або зменш файл.");
    return { mediaType: "application/pdf", data: await fileToBase64(file) };
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("Не вдалося відкрити це фото в браузері. Збережи його як JPEG або PNG і спробуй ще раз.");
  }
  const scale = Math.min(1, CLAUDE_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  return { mediaType: "image/jpeg", data: await fileToBase64(blob) };
}

async function recognizeCard(file) {
  const run = ++scanRun;
  scanOriginal = file;
  showPreview(file);
  setScanState("loading");
  if (!scanDialog.open) scanDialog.showModal();

  try {
    if (!file.type.startsWith("image/") && file.type !== "application/pdf") {
      throw new Error("Підтримуються фото і PDF.");
    }
    if (file.size > MAX_ORIGINAL_BYTES) throw new Error("Файл завеликий: до 15 МБ.");

    const payload = await prepareForClaude(file);
    const { data: auth } = await db.auth.getSession();
    if (!auth.session) throw new Error("Сесія закінчилась. Увійди в адмін-панель ще раз.");

    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.session.access_token}` },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (run !== scanRun) return;
    if (!res.ok) throw new Error(body.error || "Не вдалося розпізнати візитку. Спробуй ще раз.");

    fillScanForm(body.card);
    setScanState("review");
    scanForm.elements.name.focus();
  } catch (err) {
    if (run !== scanRun) return;
    console.error(err);
    scanOriginal = null; // нічого не зберігаємо
    setScanState("fail", err.message || "Не вдалося розпізнати візитку.");
  }
}

function fillScanForm(card) {
  scanForm.reset();
  scanError.textContent = "";
  const f = scanForm.elements;
  f.name.value = card.name || card.company || "";
  f.company.value = card.company || "";
  f.job_title.value = card.job_title || "";
  f.phone.value = card.phone || "";
  f.email.value = card.email || "";
  f.comment.value = [card.notes, card.reason].filter(Boolean).join("\n");
}

function documentPath(file) {
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif", "application/pdf": "pdf" }[file.type] || "bin";
  const month = new Date().toISOString().slice(0, 7);
  return `cards/${month}/${crypto.randomUUID()}.${ext}`;
}

document.getElementById("scan-open").addEventListener("click", () => scanFile.click());
document.getElementById("scan-retry").addEventListener("click", () => scanFile.click());
document.getElementById("scan-close").addEventListener("click", () => scanDialog.close());

scanDialog.addEventListener("close", () => {
  scanRun++; // відповідь, що запізнилась, уже не покажемо
  scanOriginal = null;
});

scanFile.addEventListener("change", () => {
  const file = scanFile.files[0];
  scanFile.value = ""; // щоб той самий файл можна було обрати ще раз
  if (file) recognizeCard(file);
});

scanForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!scanOriginal) return;

  const { client, error, field } = validateClient(scanForm);
  if (error) {
    scanError.textContent = error;
    scanForm.elements[field].focus();
    return;
  }
  const f = scanForm.elements;
  const email = f.email.value.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    scanError.textContent = "Перевір email.";
    f.email.focus();
    return;
  }

  scanSubmit.disabled = true;
  scanSubmit.textContent = "Зберігаємо…";
  scanError.textContent = "";

  try {
    const path = documentPath(scanOriginal);
    const upload = await db.storage.from("scans").upload(path, scanOriginal, { contentType: scanOriginal.type });
    if (upload.error) throw upload.error;

    const { data, error: dbError } = await db
      .from("leads")
      .insert({
        ...client,
        source: "Візитка",
        stage_id: stages[0].id,
        company: f.company.value.trim() || null,
        job_title: f.job_title.value.trim() || null,
        email: email || null,
        document_path: path,
      })
      .select(LEAD_FIELDS)
      .single();
    if (dbError) throw dbError;

    leads.unshift(data);
    await reloadHistory(data.id);
    scanDialog.close();
    render();
    notify(`«${data.name}» додано з візитки`);
  } catch (err) {
    console.error(err);
    scanError.textContent = "Не вдалося зберегти. Спробуй ще раз.";
  } finally {
    scanSubmit.disabled = false;
    scanSubmit.textContent = "Зберегти у воронку";
  }
});

// ----- Картинки для вакансій (GPT Image) -----

const genForm = document.getElementById("gen-form");
const genSubmit = document.getElementById("gen-submit");
const genError = document.getElementById("gen-error");
const genQuota = document.getElementById("gen-quota");
const genPlaceholder = document.getElementById("gen-placeholder");
const genLoading = document.getElementById("gen-loading");
const genFigure = document.getElementById("gen-figure");
const genHistory = document.getElementById("gen-history");
const genEmpty = document.getElementById("gen-empty");
const genHistoryError = document.getElementById("gen-history-error");

const STYLE_LABELS = { photo: "Фото", illustration: "Ілюстрація", flat: "Плоска графіка" };
const SIZE_LABELS = { "1536x1024": "Банер 3:2", "1024x1024": "Пост 1:1", "1024x1536": "Сторіс 2:3" };
let generating = false;

function showQuota(quota) {
  if (!quota) return;
  const left = Math.max(0, quota.day_limit - quota.used);
  genQuota.textContent = left
    ? `Сьогодні використано ${quota.used} з ${quota.day_limit}. Залишилось: ${left}.`
    : `Ліміт на сьогодні вичерпано: ${quota.used} з ${quota.day_limit}. Нові генерації — завтра.`;
  genQuota.classList.toggle("is-empty", !left);
}

async function loadQuota() {
  const { data, error } = await db.rpc("generation_quota");
  if (!error && data && data[0]) showQuota(data[0]);
}

async function signedUrls(paths) {
  if (!paths.length) return {};
  const { data, error } = await db.storage.from("generations").createSignedUrls(paths, 3600);
  if (error || !data) return {};
  return Object.fromEntries(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
}

async function loadImages() {
  genHistoryError.textContent = "";
  loadQuota();
  const { data, error } = await db
    .from("generations")
    .select("id, created_at, prompt, style, size, image_path")
    .eq("status", "done")
    .order("created_at", { ascending: false })
    .limit(48);
  if (error) {
    console.error(error);
    genHistoryError.textContent = "Не вдалося завантажити історію. Онови сторінку.";
    return;
  }
  const urls = await signedUrls(data.map((g) => g.image_path));
  genEmpty.hidden = data.length > 0;
  genHistory.replaceChildren(
    ...data.map((g) => {
      const item = document.createElement("figure");
      item.className = "gen-item";
      const link = document.createElement("a");
      link.href = urls[g.image_path] || "#";
      link.target = "_blank";
      link.rel = "noopener";
      const img = document.createElement("img");
      img.src = urls[g.image_path] || "";
      img.alt = g.prompt;
      img.loading = "lazy";
      link.append(img);
      const caption = document.createElement("figcaption");
      const prompt = document.createElement("p");
      prompt.className = "gen-item__prompt";
      prompt.textContent = g.prompt;
      const meta = document.createElement("p");
      meta.className = "gen-item__meta";
      meta.textContent = `${STYLE_LABELS[g.style] || g.style} · ${SIZE_LABELS[g.size] || g.size} · ${historyDateFormat.format(new Date(g.created_at))}`;
      caption.append(prompt, meta);
      item.append(link, caption);
      return item;
    })
  );
}

genForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (generating) return;
  const prompt = genForm.elements.prompt.value.trim();
  if (prompt.length < 3) {
    genError.textContent = "Опиши, що має бути на картинці (від 3 символів).";
    genForm.elements.prompt.focus();
    return;
  }

  generating = true;
  genSubmit.disabled = true;
  genSubmit.textContent = "Генеруємо…";
  genError.textContent = "";
  genPlaceholder.hidden = true;
  genFigure.hidden = true;
  genLoading.hidden = false;

  try {
    const { data: auth } = await db.auth.getSession();
    if (!auth.session) throw new Error("Сесія закінчилась. Увійди в адмін-панель ще раз.");
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.session.access_token}` },
      body: JSON.stringify({ prompt, style: genForm.elements.style.value, format: genForm.elements.format.value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Не вдалося згенерувати картинку. Спробуй ще раз.");

    const urls = await signedUrls([body.image_path]);
    const url = urls[body.image_path];
    document.getElementById("gen-image").src = url || "";
    document.getElementById("gen-image").alt = prompt;
    document.getElementById("gen-caption").textContent = prompt;
    document.getElementById("gen-open").href = url || "#";
    genFigure.hidden = false;
    showQuota(body.quota);
    loadImages();
  } catch (err) {
    console.error(err);
    genError.textContent = err.message;
    genPlaceholder.hidden = false;
    loadQuota();
  } finally {
    generating = false;
    genLoading.hidden = true;
    genSubmit.disabled = false;
    genSubmit.textContent = "✨ Згенерувати";
  }
});

// Оригінал лежить у закритому сховищі: показуємо за тимчасовим посиланням поруч із карткою
const docDialog = document.getElementById("doc-dialog");
let highlightedCard = null;

async function openDocument(lead, card) {
  const { data, error } = await db.storage.from("scans").createSignedUrl(lead.document_path, 300);
  if (error || !data) {
    console.error(error);
    notify("Не вдалося відкрити оригінал", true);
    return;
  }

  const body = document.getElementById("doc-body");
  if (/\.pdf$/i.test(lead.document_path)) {
    const frame = document.createElement("iframe");
    frame.src = data.signedUrl;
    frame.title = "Оригінал візитки (PDF)";
    body.replaceChildren(frame);
  } else {
    const img = new Image();
    img.src = data.signedUrl;
    img.alt = `Оригінал візитки: ${lead.name}`;
    body.replaceChildren(img);
  }
  document.getElementById("doc-who").textContent = [lead.name, lead.job_title, lead.company].filter(Boolean).join(" · ");
  document.getElementById("doc-open").href = data.signedUrl;

  if (highlightedCard) highlightedCard.classList.remove("is-highlighted");
  highlightedCard = card;
  card.classList.add("is-highlighted");
  docDialog.showModal();
}

document.getElementById("doc-close").addEventListener("click", () => docDialog.close());
docDialog.addEventListener("click", (e) => {
  if (e.target === docDialog) docDialog.close();
});
docDialog.addEventListener("close", () => {
  if (highlightedCard) highlightedCard.classList.remove("is-highlighted");
  highlightedCard = null;
});

// ----- Старт -----

(async () => {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) throw new Error(`api/config ${res.status}`);
    const { supabaseUrl, supabaseKey } = await res.json();
    db = window.supabase.createClient(supabaseUrl, supabaseKey);
  } catch (err) {
    console.error(err);
    showLogin("Не вдалося підключитися до бази. Онови сторінку.");
    loginSubmit.disabled = true;
    return;
  }

  db.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") showLogin();
  });

  const { data } = await db.auth.getSession();
  if (data.session) openPanel(data.session);
  else showLogin();
})();
