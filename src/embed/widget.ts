/*! pageview-widget embed v1.0.0 | MIT License | 零依赖，未压缩 < 2KB */
const d = document;
const s = (d.currentScript || d.querySelector("script[src*=widget]")) as HTMLScriptElement | null;
const ds: Record<string, string | undefined> = s ? s.dataset : {};
const api = () => (ds.pvApi || "").replace(/\/+$/, "") + "/api/count";
let path = "";
const counters = () => d.querySelectorAll<HTMLElement>(".pageview-count");
const target = (el: HTMLElement) => el.dataset.pvPath || path;

function paint(p: string, v: number) {
  for (const el of counters()) if (target(el) === p) el.textContent = String(v);
}

function query(list: string) {
  fetch(api() + "?paths=" + encodeURIComponent(list))
    .then((r) => r.json())
    .then((j: { views: Record<string, number> }) => {
      for (const k in j.views) {
        const v = j.views[k];
        if (v !== undefined) paint(k, v);
      }
    })
    .catch(() => {});
}

function track() {
  path = ds.pvPath || location.pathname;
  const targets = [...new Set(Array.from(counters(), target))];
  if ("pvOnce" in ds) {
    if (targets.length) query(targets.join(","));
    return;
  }
  fetch(api(), { method: "POST", body: JSON.stringify({ path }), keepalive: true })
    .then((r) => r.json())
    .then((j: { views: number }) => paint(path, j.views))
    .catch(() => {});
  const others = targets.filter((t) => t !== path);
  if (others.length) query(others.join(","));
}

function wrap(orig: History["pushState"]): History["pushState"] {
  return function (this: History, ...args: Parameters<History["pushState"]>) {
    const result = orig.apply(this, args);
    track();
    return result;
  };
}

history.pushState = wrap(history.pushState);
history.replaceState = wrap(history.replaceState);
addEventListener("popstate", track);
if (d.readyState === "loading") addEventListener("DOMContentLoaded", track);
else track();
