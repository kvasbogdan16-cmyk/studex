// Telegram Mini App Studex: вакансії, заявка в CRM, «Мої заявки».
// Хто відкрив додаток, визначає сервер за підписаними даними Telegram (initData).
// Без Telegram сторінка нічого не завантажує і просить відкрити бота.

const BOT_USERNAME = ""; // нікнейм бота без @ (для посилання, коли сторінку відкрили не в Telegram)

const VACANCIES = [
  { icon: "☕", type: "part", title: "Бариста", company: "Кав'ярня в центрі міста", meta: ["🕒 Вечори та вихідні", "📍 Офлайн", "🎓 Без досвіду"] },
  { icon: "📱", type: "full", title: "SMM-стажер", company: "Діджитал-агенція", meta: ["🕒 Часткова зайнятість", "📍 Гібрид", "📚 Навчання в команді"] },
  { icon: "📐", type: "part", title: "Репетитор з математики", company: "Освітній онлайн-центр", meta: ["🕒 Свій графік", "📍 Віддалено", "👩‍🎓 Для 2+ курсу"] },
  { icon: "🛵", type: "part", title: "Кур'єр", company: "Служба доставки", meta: ["🕒 Зміни від 4 годин", "📍 Офлайн", "💸 Щотижнева оплата"] },
  { icon: "🎪", type: "volunteer", title: "Волонтер на фестивалі", company: "Міський культурний фестиваль", meta: ["🕒 Вихідні", "📍 Офлайн", "📜 Сертифікат учасника"] },
  { icon: "🧪", type: "full", title: "Junior QA-тестувальник", company: "IT-компанія", meta: ["🕒 Повна зайнятість", "📍 Віддалено", "🧑‍🏫 Ментор на старті"] },
  { icon: "🐾", type: "volunteer", title: "Помічник у притулку", company: "Притулок для тварин", meta: ["🕒 2–3 години на тиждень", "📍 Офлайн", "❤️ Без досвіду"] },
  { icon: "🎨", type: "full", title: "Junior-дизайнер", company: "Продуктова студія", meta: ["🕒 Повна зайнятість", "📍 Гібрид", "🖼️ Достатньо портфоліо"] },
];

const TYPE_LABELS = { full: "Постійна", part: "Підробіток", volunteer: "Волонтерство" };

const tg = window.Telegram && window.Telegram.WebApp;
const $ = (id) => document.getElementById(id);

const views = ["loading", "outside", "error", "app", "apply", "done"];
let me = null; // { user, leads }
let currentJob = null;
let currentType = "all";

const dateFormat = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

function show(view) {
  views.forEach((v) => ($("view-" + v).hidden = v !== view));
  window.scrollTo(0, 0);
  if (!tg || !tg.BackButton) return;
  if (view === "apply") tg.BackButton.show();
  else tg.BackButton.hide();
}

function haptic(type) {
  try {
    tg.HapticFeedback.notificationOccurred(type);
  } catch {}
}

async function api(path, payload) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData: tg.initData, ...payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Сервер не відповідає. Спробуй ще раз.");
  return body;
}

// ----- Вакансії -----

function renderJobs() {
  const list = VACANCIES.filter((j) => currentType === "all" || j.type === currentType);
  $("jobs").replaceChildren(
    ...list.map((job) => {
      const card = $("job-template").content.firstElementChild.cloneNode(true);
      card.querySelector(".job__icon").textContent = job.icon;
      const tag = card.querySelector(".tag");
      tag.textContent = TYPE_LABELS[job.type];
      tag.classList.add("tag--" + job.type);
      card.querySelector(".job__title").textContent = job.title;
      card.querySelector(".job__company").textContent = job.company;
      card.querySelector(".job__meta").replaceChildren(
        ...job.meta.map((m) => Object.assign(document.createElement("li"), { textContent: m }))
      );
      card.querySelector(".job__apply").addEventListener("click", () => openApply(job));
      return card;
    })
  );
}

document.querySelectorAll(".chip").forEach((chip) =>
  chip.addEventListener("click", () => {
    currentType = chip.dataset.type;
    document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("is-active", c === chip));
    renderJobs();
  })
);

// ----- Вкладки -----

function openTab(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    const active = t.dataset.tab === name;
    t.classList.toggle("is-active", active);
    t.setAttribute("aria-selected", String(active));
  });
  $("tab-jobs").hidden = name !== "jobs";
  $("tab-mine").hidden = name !== "mine";
}

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => openTab(t.dataset.tab)));

// ----- Мої заявки -----

function renderMine() {
  const leads = (me && me.leads) || [];
  $("mine-count").textContent = leads.length;
  $("mine-empty").hidden = leads.length > 0;
  $("mine").replaceChildren(
    ...leads.map((lead) => {
      const item = document.createElement("article");
      item.className = "mine-item";

      const top = document.createElement("div");
      top.className = "mine-item__top";
      const title = document.createElement("p");
      title.className = "mine-item__title";
      const firstLine = (lead.comment || "").split("\n")[0];
      title.textContent = firstLine.startsWith("Вакансія: ") ? firstLine.slice(10) : "Заявка";
      const stage = document.createElement("span");
      stage.className = "stage";
      stage.dataset.kind = lead.stage_kind;
      stage.textContent = lead.stage;
      top.append(title, stage);

      const date = document.createElement("p");
      date.className = "mine-item__date";
      date.textContent = "Надіслано " + dateFormat.format(new Date(lead.created_at));

      item.append(top, date);
      return item;
    })
  );
}

// ----- Заявка -----

function openApply(job) {
  currentJob = job;
  const box = $("apply-job");
  box.replaceChildren();
  const tag = document.createElement("span");
  tag.className = "tag tag--" + job.type;
  tag.textContent = TYPE_LABELS[job.type];
  tag.style.justifySelf = "start";
  const title = document.createElement("h1");
  title.className = "title";
  title.textContent = `${job.icon} ${job.title}`;
  const company = document.createElement("p");
  company.className = "muted";
  company.textContent = job.company;
  box.append(tag, title, company);

  $("apply-name").textContent = me.user.name;
  $("apply-error").textContent = "";
  show("apply");
}

function closeApply() {
  show("app");
}

$("apply-cancel").addEventListener("click", closeApply);
if (tg && tg.BackButton) tg.BackButton.onClick(closeApply);

$("share-phone").addEventListener("click", () => {
  tg.requestContact((sent, event) => {
    const phone = sent && event && event.responseUnsafe && event.responseUnsafe.contact && event.responseUnsafe.contact.phone_number;
    if (!phone) return;
    $("apply-phone").value = phone.startsWith("+") ? phone : "+" + phone;
  });
});

$("apply-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const phone = $("apply-phone").value.trim();
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 13) {
    $("apply-error").textContent = "Перевір номер телефону: потрібно 10–13 цифр.";
    $("apply-phone").focus();
    haptic("error");
    return;
  }

  const submit = $("apply-submit");
  submit.disabled = true;
  submit.textContent = "Надсилаємо…";
  $("apply-error").textContent = "";

  try {
    await api("/api/tg-lead", {
      phone,
      vacancy: `${currentJob.title} (${TYPE_LABELS[currentJob.type]})`,
      comment: $("apply-comment").value.trim(),
    });
    haptic("success");
    $("done-text").textContent = `${me.user.first_name || me.user.name}, ми отримали твою заявку на «${currentJob.title}» і скоро зв'яжемося з тобою. Статус видно у «Моїх заявках».`;
    $("apply-form").reset();
    show("done");
    me = await api("/api/tg-me", {}); // оновлюємо «Мої заявки»
    renderMine();
  } catch (err) {
    haptic("error");
    $("apply-error").textContent = err.message;
  } finally {
    submit.disabled = false;
    submit.textContent = "Надіслати заявку";
  }
});

$("done-mine").addEventListener("click", () => {
  openTab("mine");
  show("app");
});
$("done-jobs").addEventListener("click", () => {
  openTab("jobs");
  show("app");
});

// ----- Старт -----

async function load() {
  show("loading");
  try {
    me = await api("/api/tg-me", {});
    $("hello-title").textContent = `Привіт, ${me.user.first_name || me.user.name}! 👋`;
    renderJobs();
    renderMine();
    show("app");
  } catch (err) {
    $("error-text").textContent = err.message;
    show("error");
  }
}

$("error-retry").addEventListener("click", load);

if (!tg || !tg.initData) {
  // Сторінку відкрили у звичайному браузері: даних немає і ми їх не запитуємо
  if (BOT_USERNAME) {
    const link = $("bot-link");
    link.href = "https://t.me/" + BOT_USERNAME;
    link.hidden = false;
  }
  show("outside");
} else {
  tg.ready();
  tg.expand();
  // На телефоні — справжній повноекранний режим (Telegram 8.0+)
  if (["android", "ios"].includes(tg.platform) && tg.isVersionAtLeast && tg.isVersionAtLeast("8.0")) {
    try {
      tg.requestFullscreen();
    } catch {}
  }
  if (tg.requestContact && tg.isVersionAtLeast && tg.isVersionAtLeast("6.9")) $("share-phone").hidden = false;
  load();
}
