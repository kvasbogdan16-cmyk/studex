// Адмін-панель: вхід, список заявок, зміна статусу, фільтр
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
const leadsList = document.getElementById("leads-list");
const leadsEmpty = document.getElementById("leads-empty");
const leadsError = document.getElementById("leads-error");
const leadTemplate = document.getElementById("lead-template");
const filterButtons = document.querySelectorAll("#status-filters .filter");
const toast = document.getElementById("toast");

const STATUS_LABELS = { "нова": "Нова", "в роботі": "В роботі", "закрита": "Закрита" };
const dateFormat = new Intl.DateTimeFormat("uk-UA", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

let leads = [];
let currentFilter = "all";

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
  loadLeads();
}

function showLogin(message = "") {
  userBox.hidden = true;
  leads = [];
  leadsList.replaceChildren();
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

// ----- Заявки -----

async function loadLeads() {
  leadsError.textContent = "";
  const { data, error } = await db
    .from("leads")
    .select("id, created_at, name, phone, comment, status")
    .order("created_at", { ascending: false });

  if (error) {
    console.error(error);
    leadsError.textContent = "Не вдалося завантажити заявки. Онови сторінку.";
    return;
  }

  leads = data;
  render();
}

function render() {
  const counts = { all: leads.length, "нова": 0, "в роботі": 0, "закрита": 0 };
  leads.forEach((lead) => counts[lead.status]++);
  document.querySelectorAll("[data-count]").forEach((el) => {
    el.textContent = counts[el.dataset.count];
  });

  const visible = currentFilter === "all" ? leads : leads.filter((l) => l.status === currentFilter);
  leadsList.replaceChildren(...visible.map(renderLead));
  leadsEmpty.hidden = visible.length > 0;
  leadsEmpty.textContent = leads.length ? "Немає заявок з таким статусом." : "Заявок поки немає.";
}

function renderLead(lead) {
  const card = leadTemplate.content.firstElementChild.cloneNode(true);
  card.dataset.status = lead.status;
  card.querySelector(".lead__name").textContent = lead.name;

  const time = card.querySelector(".lead__date");
  time.dateTime = lead.created_at;
  time.textContent = dateFormat.format(new Date(lead.created_at));

  const phone = card.querySelector(".lead__phone");
  phone.textContent = lead.phone;
  phone.href = "tel:" + lead.phone.replace(/[^\d+]/g, "");

  card.querySelector(".lead__comment").textContent = lead.comment || "";

  const select = card.querySelector("select");
  select.value = lead.status;
  select.addEventListener("change", () => changeStatus(lead, select));

  return card;
}

async function changeStatus(lead, select) {
  const previous = lead.status;
  const next = select.value;
  select.disabled = true;

  const { data, error } = await db
    .from("leads")
    .update({ status: next })
    .eq("id", lead.id)
    .select("id");

  select.disabled = false;

  if (error || !data || data.length === 0) {
    console.error(error);
    select.value = previous;
    notify("Не вдалося змінити статус", true);
    return;
  }

  lead.status = next;
  notify(`«${lead.name}»: ${STATUS_LABELS[next]}`);
  render();
}

filterButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    currentFilter = btn.dataset.status;
    filterButtons.forEach((b) => {
      const active = b === btn;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-selected", String(active));
    });
    render();
  });
});

document.getElementById("refresh").addEventListener("click", loadLeads);

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
