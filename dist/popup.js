// src/ui/common.ts
async function call(req) {
  const r = await chrome.runtime.sendMessage(req);
  if (!r)
    throw new Error("No answer from the extension");
  if (!r.ok)
    throw new Error(r.error);
  return r.value;
}
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false)
      continue;
    if (k === "class")
      el.className = String(v);
    else if (k.startsWith("on") && typeof v === "function")
      el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== "string")
      el[k] = v;
    else
      el.setAttribute(k, String(v));
  }
  for (const c of children)
    if (c != null && c !== false)
      el.append(c);
  return el;
}
function ago(t) {
  if (t == null)
    return "never";
  const ms = Date.now() - (typeof t === "string" ? Date.parse(t) : t);
  if (ms < 45000)
    return "just now";
  const m = Math.round(ms / 60000);
  if (m < 60)
    return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24)
    return `${hr} h ago`;
  return `${Math.round(hr / 24)} d ago`;
}
async function busy(btn, label, fn, onError) {
  const text = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    await fn();
  } catch (e) {
    onError(e instanceof Error ? e.message : String(e));
  } finally {
    btn.disabled = false;
    btn.textContent = text;
  }
}

// src/ui/icons.ts
var ICONS = {
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>'
};
function icon(name, size = 18) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24",
    width: String(size),
    height: String(size),
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true"
  }))
    svg.setAttribute(k, v);
  svg.innerHTML = ICONS[name];
  return svg;
}

// src/ui/theme.ts
var THEME_KEY = "theme";
var darkQuery = matchMedia("(prefers-color-scheme: dark)");
function apply(theme) {
  if (theme === "system")
    delete document.documentElement.dataset.theme;
  else
    document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {}
}
function shown(theme) {
  return theme === "system" ? darkQuery.matches ? "dark" : "light" : theme;
}
async function getTheme() {
  return (await chrome.storage.local.get(THEME_KEY))[THEME_KEY] ?? "system";
}
async function setTheme(theme) {
  apply(theme);
  await chrome.storage.local.set({ [THEME_KEY]: theme });
}
function watchTheme(onChange) {
  let current = "system";
  const update = (theme) => {
    current = theme;
    apply(theme);
    onChange?.(theme);
  };
  getTheme().then(update);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && THEME_KEY in changes)
      update(changes[THEME_KEY].newValue ?? "system");
  });
  darkQuery.addEventListener("change", () => onChange?.(current));
}
function themeToggle(button) {
  let current = "system";
  watchTheme((theme) => {
    current = theme;
    const dark = shown(theme) === "dark";
    const label = dark ? "Switch to light mode" : "Switch to dark mode";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.replaceChildren(icon(dark ? "sun" : "moon"));
  });
  button.addEventListener("click", () => void setTheme(shown(current) === "dark" ? "light" : "dark"));
}

// src/ui/popup.ts
var app = document.getElementById("app");
var error = "";
var summary;
themeToggle(document.getElementById("theme"));
var settings = document.getElementById("settings");
settings.append(icon("settings"));
settings.addEventListener("click", () => chrome.runtime.openOptionsPage());
chrome.runtime.onMessage.addListener((m) => {
  if (m.type === "changed")
    render();
});
var fail = (e) => {
  error = e;
  render();
};
async function render() {
  let s;
  try {
    s = await call({ type: "status" });
  } catch (e) {
    app.replaceChildren(h("p", { class: "error" }, String(e)));
    return;
  }
  const parts = [];
  if (error)
    parts.push(h("p", { class: "error", onclick: () => (error = "", render()) }, error));
  parts.push(accountsCard(s));
  const active = s.accounts.find((a) => a.sub === s.active);
  if (active?.linked)
    summary = undefined;
  if (active)
    parts.push(active.linked ? syncCard(s, active) : linkCard(s, active));
  parts.push(h("footer", {}, `Sites: ${s.domains.join(", ")}`));
  app.replaceChildren(...parts);
}
function accountsCard(s) {
  const rows = s.accounts.map((a) => h("label", { class: `account${a.sub === s.active ? " active" : ""}` }, h("input", {
    type: "radio",
    name: "active",
    checked: a.sub === s.active,
    onchange: () => call({ type: "setActive", sub: a.sub }).then(render, (e) => fail(e.message))
  }), a.picture ? h("img", { src: a.picture, alt: "", class: "avatar", referrerpolicy: "no-referrer" }) : h("span", { class: "avatar" }, (a.email[0] ?? "?").toUpperCase()), h("span", { class: "who" }, h("b", {}, a.name || a.email), a.name ? h("small", {}, a.email) : null), a.needsAuth ? h("span", { class: "badge warn" }, "Sign in") : a.linked ? h("span", { class: "badge ok" }, "Sync on") : null, h("button", {
    class: "icon",
    title: `Remove ${a.email} from this browser`,
    onclick: (e) => {
      e.preventDefault();
      if (confirm(`Remove ${a.email} from this browser? The backup in its Drive stays.`))
        call({ type: "removeAccount", sub: a.sub }).then(render, (err) => fail(err.message));
    }
  }, "×")));
  const add = h("button", { class: s.accounts.length ? "link" : "primary" }, s.accounts.length ? "+ Add another Google account" : "Connect Google account");
  add.addEventListener("click", () => void busy(add, "Waiting for Google…", () => call({ type: "addAccount" }).then(render), fail));
  return h("section", { class: "card" }, h("h2", {}, s.accounts.length > 1 ? "Google account to sync with" : "Google account"), s.accounts.length ? h("div", { class: "accounts" }, ...rows) : h("p", { class: "muted" }, "Connect a Google account to back up your reading history and names to its Google Drive."), add);
}
function reconnectNotice(a) {
  if (!a.needsAuth)
    return null;
  const btn = h("button", { class: "primary" }, "Sign in again");
  btn.addEventListener("click", () => void busy(btn, "Waiting for Google…", () => call({ type: "reconnect", sub: a.sub }).then(render), fail));
  return h("div", { class: "notice warn" }, h("p", {}, `Google needs you to sign in to ${a.email} again.`), btn);
}
function linkCard(s, a) {
  const card = h("section", { class: "card" }, h("h2", {}, "Google Drive"));
  if (s.notice)
    card.append(h("p", { class: "notice warn" }, s.notice));
  const notice = reconnectNotice(a);
  if (notice) {
    card.append(notice);
    return card;
  }
  if (summary?.sub !== a.sub) {
    summary = { sub: a.sub };
    call({ type: "summary" }).then((value) => (summary = { sub: a.sub, value }, render()), (e) => (summary = { sub: a.sub, error: e.message }, render()));
  }
  if (summary.error) {
    card.append(h("p", { class: "error" }, summary.error));
    return card;
  }
  if (!summary.value) {
    card.append(h("p", { class: "muted" }, "Checking Google Drive…"));
    return card;
  }
  const r = summary.value;
  const others = r.devices.filter((d) => !d.self);
  const btn = h("button", { class: "primary" }, r.exists ? "Sync this browser" : "Start syncing");
  btn.addEventListener("click", () => void busy(btn, "Syncing…", () => call({ type: "link" }).then(render), fail));
  card.append(r.exists ? h("p", {}, `A backup already exists in this Drive${others.length ? ` (from ${others.map((d) => d.name).join(", ")})` : ""}, updated ${ago(r.exportUpdated ?? others[0]?.updated)}. `, "Syncing merges this browser's reading history and names with it — newer changes win, nothing newer is overwritten.") : h("p", {}, "No backup in this Drive yet. Syncing uploads this browser's reading history and names, then keeps them up to date."), btn);
  if (!s.openTabs)
    card.append(h("p", { class: "muted small" }, "This browser's data is read from an open SangTacViet tab; it is picked up the next time one is open."));
  return card;
}
function syncCard(s, a) {
  const card = h("section", { class: "card" }, h("h2", {}, "Google Drive sync"));
  const notice = reconnectNotice(a);
  if (notice)
    card.append(notice);
  const state = s.syncing ? h("p", { class: "status busy" }, "Syncing…") : s.lastError ? h("p", { class: "status bad" }, s.lastError) : h("p", { class: "status good" }, `Up to date · synced ${ago(s.lastSync)}`);
  card.append(state);
  const n = (k, word) => `${k} ${word}${k === 1 ? "" : "s"}`;
  if (s.counts)
    card.append(h("p", { class: "muted" }, `${n(s.counts.books, "book")} in history · ${n(s.counts.names, "name")} in ${n(s.counts.nameLists, "book")}`));
  const now = h("button", { class: "primary" }, "Sync now");
  now.addEventListener("click", () => void busy(now, "Syncing…", () => call({ type: "syncNow" }).then(render), fail));
  const dl = h("button", {}, "Download .txt");
  dl.addEventListener("click", () => void busy(dl, "Preparing…", async () => {
    const text = await call({ type: "export" });
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = h("a", { href: url, download: `dulieu${new Date().toJSON().slice(0, 10)}.txt` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, fail));
  card.append(h("div", { class: "row" }, now, dl));
  if (s.devices.length) {
    card.append(h("h3", {}, "Browsers on this account"), h("ul", { class: "devices" }, ...s.devices.map((d) => h("li", {}, h("span", {}, d.self ? `${d.name} (this browser)` : d.name), h("small", {}, ago(d.updated))))), h("button", { class: "link small", onclick: () => chrome.runtime.openOptionsPage() }, "Rename or remove browsers in Settings"));
  }
  const stop = h("button", { class: "link danger" }, "Stop syncing in this browser");
  stop.addEventListener("click", () => {
    if (confirm("Stop syncing this browser? Data already in Drive and in this browser stays."))
      busy(stop, "…", () => call({ type: "unlink" }).then(() => (summary = undefined, render())), fail);
  });
  card.append(stop);
  return card;
}
render();
