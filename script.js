document.documentElement.classList.add("js");

// Мобільне меню
const burger = document.getElementById("burger");
const nav = document.getElementById("nav");

function setMenu(open) {
  nav.classList.toggle("is-open", open);
  burger.setAttribute("aria-expanded", String(open));
  burger.setAttribute("aria-label", open ? "Закрити меню" : "Відкрити меню");
}

burger.addEventListener("click", () => {
  setMenu(!nav.classList.contains("is-open"));
});

nav.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => setMenu(false));
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setMenu(false);
});

// Тінь шапки під час прокручування
const header = document.querySelector(".header");
const onScroll = () => header.classList.toggle("is-scrolled", window.scrollY > 8);
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

// Фільтр вакансій
const filters = document.querySelectorAll(".filter");
const jobs = document.querySelectorAll(".job");

filters.forEach((btn) => {
  btn.addEventListener("click", () => {
    const type = btn.dataset.filter;

    filters.forEach((f) => {
      const active = f === btn;
      f.classList.toggle("is-active", active);
      f.setAttribute("aria-selected", String(active));
    });

    jobs.forEach((job) => {
      const show = type === "all" || job.dataset.type === type;
      job.classList.toggle("is-hidden", !show);
      job.classList.remove("is-entering");
      if (show) {
        void job.offsetWidth; // перезапуск анімації
        job.classList.add("is-entering");
      }
    });
  });
});

// Форма заявки → /api/lead → Supabase + Telegram
const applyForm = document.getElementById("apply-form");
const applySuccess = document.getElementById("apply-success");
const applySuccessText = document.getElementById("apply-success-text");
const applyAgain = document.getElementById("apply-again");

function setFieldError(input, message) {
  const field = input.closest(".field");
  const error = document.getElementById(input.id + "-error");
  field.classList.toggle("is-invalid", Boolean(message));
  input.setAttribute("aria-invalid", message ? "true" : "false");
  if (error) {
    error.textContent = message;
    input.setAttribute("aria-describedby", error.id);
  }
}

function validateName(input) {
  const value = input.value.trim();
  if (!value) return "Вкажи своє ім'я";
  if (value.length < 2) return "Ім'я має містити хоча б 2 літери";
  return "";
}

function validatePhone(input) {
  const digits = input.value.replace(/\D/g, "");
  if (!digits) return "Вкажи номер телефону";
  if (digits.length < 10 || digits.length > 13) return "Перевір номер: наприклад, +380 67 123 45 67";
  return "";
}

const validators = [
  [applyForm.elements.name, validateName],
  [applyForm.elements.phone, validatePhone],
];

// Прибираємо помилку, щойно користувач виправив поле
validators.forEach(([input, validate]) => {
  input.addEventListener("input", () => {
    if (input.closest(".field").classList.contains("is-invalid")) {
      setFieldError(input, validate(input));
    }
  });
});

applyForm.addEventListener("submit", (e) => {
  e.preventDefault();

  let firstInvalid = null;
  validators.forEach(([input, validate]) => {
    const message = validate(input);
    setFieldError(input, message);
    if (message && !firstInvalid) firstInvalid = input;
  });

  if (firstInvalid) {
    firstInvalid.focus();
    return;
  }

  sendApplication();
});

async function sendApplication() {
  const submitBtn = applyForm.querySelector(".apply__submit");
  const formError = document.getElementById("apply-form-error");
  const name = applyForm.elements.name.value.trim();
  const lead = {
    name,
    phone: applyForm.elements.phone.value.trim(),
    comment: applyForm.elements.comment.value.trim() || null,
  };

  submitBtn.disabled = true;
  submitBtn.textContent = "Надсилаємо…";
  formError.textContent = "";

  try {
    // Серверний обробник (api/lead.js): зберігає в Supabase і надсилає сповіщення в Telegram
    const res = await fetch("/api/lead", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lead),
    });
    if (!res.ok) throw new Error(`api/lead ${res.status}: ${await res.text()}`);

    applySuccessText.textContent = `${name}, ми зв'яжемося з тобою найближчим часом.`;
    applyForm.hidden = true;
    applySuccess.hidden = false;
    applySuccess.focus();
  } catch (err) {
    console.error(err);
    formError.textContent = "Не вдалося надіслати заявку. Перевір інтернет і спробуй ще раз.";
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Надіслати заявку";
  }
}

applyAgain.addEventListener("click", () => {
  applyForm.reset();
  applyForm.hidden = false;
  applySuccess.hidden = true;
  applyForm.elements.name.focus();
});

// Плавна поява блоків
const revealItems = document.querySelectorAll(".reveal");

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
  );
  revealItems.forEach((el) => observer.observe(el));
} else {
  revealItems.forEach((el) => el.classList.add("is-visible"));
}
