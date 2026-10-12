// Loaded synchronously in <head> (no inline scripts allowed by CSP): follow the OS light/dark preference.
const mq = matchMedia("(prefers-color-scheme: dark)");
const apply = () => document.documentElement.setAttribute("data-bs-theme", mq.matches ? "dark" : "light");
apply();
mq.addEventListener("change", apply);
