export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const rand = (n = 5) => Math.random().toString(36).slice(2, 2 + n);
export const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const money = (n, cur = "") => (n == null ? "–" : `${Number(n).toFixed(2)} ${cur}`.trim());
export const num = (v, d = 5) => Number(Number(v).toFixed(d));
export const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour12: false });

export function toast(message, kind = "dark", ms = 3500) {
  const host = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = `toast align-items-center text-bg-${kind} border-0 show mb-2`;
  el.innerHTML = `<div class="d-flex"><div class="toast-body py-2 small">${esc(message)}</div></div>`;
  host.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
