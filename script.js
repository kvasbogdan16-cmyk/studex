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
