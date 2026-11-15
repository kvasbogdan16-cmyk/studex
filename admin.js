// Адмін-панель: вхід, воронка заявок, ручне додавання клієнта, історія переходів
// Адреса і ключ Supabase приходять із /api/config (налаштування Vercel), у коді їх немає.
let db;

const views = {
  loading: document.getElementById("view-loading"),
  login: document.getElementById("view-login"),
  leads: document.getElementById("view-leads"),
};

const userBox = document.getElementById("user-box");
const userEmail = document.getElementById("user-email");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const loginSubmit = document.getElementById("login-submit");
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

const LEAD_FIELDS = "id, created_at, name, phone, comment, source, stage_id";
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
}

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
  loginError.textContent = message;
  show("login");
}

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

document.getElementById("logout").addEventListener("click", async () => {
  await db.auth.signOut();
  showLogin();
});

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

  const phone = card.querySelector(".lead__phone");
  phone.textContent = lead.phone;
  phone.href = "tel:" + lead.phone.replace(/[^\d+]/g, "");

  card.querySelector(".lead__comment").textContent = lead.comment || "";

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
      stage_id: Number(form.elements.stage.value),
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
