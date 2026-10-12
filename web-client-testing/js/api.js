import { addLog, save, state } from "./state.js";

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}

export const apiBase = () => (state.settings.apiBase || `${location.origin}/api/v1`).replace(/\/+$/, "");
export const rootBase = () => apiBase().replace(/\/api\/v1$/, "");

async function send(method, url, body, token) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (e) {
    return { status: 0, json: { error: { code: "NETWORK", message: e.message || "Network error" } }, ms: Math.round(performance.now() - t0) };
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, json, ms: Math.round(performance.now() - t0) };
}

const refreshing = new Map(); // actor.id -> Promise (single flight)
export function refreshTokens(actor) {
  if (!refreshing.has(actor.id)) {
    const p = (async () => {
      const r = await send("POST", `${apiBase()}/auth/refresh`, { refreshToken: actor.tokens.refreshToken });
      log(actor, "POST", "/auth/refresh", { refreshToken: "…" }, r, false);
      if (r.status !== 200) throw new ApiError(r.status, r.json?.error?.code, r.json?.error?.message || "refresh failed");
      actor.tokens = r.json.tokens;
      save();
    })().finally(() => refreshing.delete(actor.id));
    refreshing.set(actor.id, p);
  }
  return refreshing.get(actor.id);
}

function log(actor, method, path, req, r, quiet) {
  addLog({ t: Date.now(), who: actor ? `${actor.role}:${actor.name}` : "anon", method, path, status: r.status, ms: r.ms, req, res: r.json, quiet: !!quiet });
}

/**
 * Call the API as `actor` (or anonymously). Transparently refreshes an expired access token once.
 * Throws ApiError on non-2xx. Returns parsed JSON (null for 204).
 * opts.quiet: mark as background polling (hidden in the log by default).
 */
export async function call(actor, method, path, body, opts = {}) {
  const url = `${apiBase()}${path}`;
  let r = await send(method, url, body, actor?.tokens?.accessToken);
  if (r.status === 401 && r.json?.error?.code === "TOKEN_EXPIRED" && actor?.tokens?.refreshToken) {
    await refreshTokens(actor);
    r = await send(method, url, body, actor.tokens.accessToken);
  }
  log(actor, method, path, body, r, opts.quiet);
  if (r.status < 200 || r.status >= 300) {
    const e = r.json?.error || {};
    throw new ApiError(r.status, e.code || "ERROR", e.message || `HTTP ${r.status}`, e.details);
  }
  return r.json;
}

/** Raw call that never throws (for assertions on expected errors). Returns {status, json}. */
export async function tryCall(actor, method, path, body) {
  try { return { status: 200, json: await call(actor, method, path, body) }; }
  catch (e) { if (e instanceof ApiError) return { status: e.status, json: { error: { code: e.code, message: e.message } } }; throw e; }
}

export async function ping() {
  const r = await send("GET", `${rootBase()}/ready`);
  return r;
}
