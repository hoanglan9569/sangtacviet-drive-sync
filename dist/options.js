// src/background/settings.ts
var DEFAULT_DOMAINS = ["sangtacviet.com", "sangtacviet.app"];
var local = {
  async get(key) {
    return (await chrome.storage.local.get(key))[key];
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(key) {
    await chrome.storage.local.remove(key);
  }
};
function defaultDeviceName() {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : "Chrome";
  return `${browser}${os ? ` on ${os}` : ""}`;
}
var deviceInit;
function ensureDevice() {
  deviceInit ??= (async () => {
    const stored = await local.get("device");
    if (stored)
      return stored;
    const device = { id: crypto.randomUUID().slice(0, 8), name: defaultDeviceName() };
    await local.set("device", device);
    return device;
  })();
  return deviceInit;
}
async function getSettings() {
  const s = await local.get("settings") ?? {};
  return {
    device: await local.get("device") ?? await ensureDevice(),
    domains: s.domains ?? DEFAULT_DOMAINS,
    accounts: s.accounts ?? [],
    active: s.active,
    linked: s.linked ?? {},
    hosts: s.hosts ?? [],
    driveBase: s.driveBase
  };
}
async function updateSettings(fn) {
  const raw = await local.get("settings") ?? {};
  const next = { ...raw, ...fn(await getSettings()) };
  await local.set("settings", next);
  return getSettings();
}
function domainPatterns(domains) {
  return domains.flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]);
}

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

// src/shared/versions.ts
var KEEP_FOREVER = 180;

// src/ui/versions.ts
var $ = (id) => document.getElementById(id);
var dialog = $("versions-dialog");
var status;
var data;
var error = "";
var selected;
var account = () => status?.accounts.find((a) => a.sub === status?.active);
var plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
var temporary = (list) => {
  const n = list.filter((v) => v.temporary).length;
  return n ? ` (${n} temporary)` : "";
};
var what = (v) => v.books !== undefined && v.names !== undefined ? `${plural(v.books, "book")} · ${plural(v.names, "name")}` : v.size !== undefined ? `${Math.max(1, Math.round(v.size / 1024))} KB` : "";
var time = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function dayLabel(day) {
  const d = new Date(`${day}T00:00`);
  const today = new Date;
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - d.getTime()) / 86400000);
  if (diff === 0)
    return "Today";
  if (diff === 1)
    return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}
var inFlight;
function refreshVersions() {
  inFlight ??= (async () => {
    try {
      status = await call({ type: "status" });
      const sub = status.active;
      data = sub ? { sub, ...await call({ type: "versions" }) } : undefined;
      error = "";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    render();
  })().finally(() => inFlight = undefined);
  return inFlight;
}
function render() {
  const a = account();
  const versions = data?.sub === a?.sub ? data?.versions ?? [] : [];
  if (selected && !versions.some((v) => v.id === selected))
    selected = undefined;
  const summary = $("versions-summary");
  if (!a)
    summary.textContent = "Connect a Google account in the popup to keep versions.";
  else if (error && !data)
    summary.replaceChildren(h("span", { class: "error" }, error));
  else
    summary.replaceChildren(!data ? "…" : versions.length ? `${plural(versions.length, "version")}${temporary(versions)} · newest ${ago(versions[0].at)}` : a.linked ? "No versions yet: the next sync saves one." : "Start syncing this account to keep versions.");
  $("versions-error").textContent = error;
  const groups = new Map;
  for (const v of versions)
    groups.set(v.day, [...groups.get(v.day) ?? [], v]);
  $("versions").replaceChildren(...versions.length ? [] : [h("p", { class: "muted small" }, "No versions yet.")], ...[...groups].flatMap(([day, list]) => [
    h("h3", {}, dayLabel(day)),
    ...list.map((v) => h("label", { class: `version${v.id === selected ? " selected" : ""}` }, h("input", { type: "radio", name: "version", value: v.id, checked: v.id === selected, onchange: () => select(v.id) }), h("b", {}, time(v.at)), h("small", { class: "muted" }, [
      v.current ? "latest" : "",
      v.temporary ? "temporary" : "",
      what(v),
      v.deviceName,
      v.reason === "manual" ? "saved by hand" : v.reason === "restore" ? "saved before a restore" : v.reason === "join" ? "its own data before joining" : ""
    ].filter(Boolean).join(" · "))))
  ]));
  const none = !selected;
  for (const id of ["version-download", "version-delete", "version-restore"])
    $(id).disabled = none;
  const current = !!chosen()?.current;
  $("version-delete").disabled = none || current;
  $("version-delete").title = current ? "The latest version is dulieu.txt's current content and can't be deleted." : "";
  $("version-restore").disabled = none || !a?.linked;
  $("version-save-now").disabled = !a?.linked;
}
function select(id) {
  selected = id;
  render();
}
var fail = (e) => $("versions-error").textContent = e;
var chosen = () => data?.versions.find((v) => v.id === selected);
var when = (v) => `${dayLabel(v.day).toLowerCase()} at ${time(v.at)}`;
function open() {
  render();
  dialog.showModal();
  refreshVersions();
}
$("versions-card").addEventListener("click", open);
$("versions-card").addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open()));
$("versions-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (e) => e.target === dialog && dialog.close());
$("keep-forever").textContent = String(KEEP_FOREVER);
$("version-save-now").addEventListener("click", (e) => void busy(e.currentTarget, "Saving…", async () => {
  await call({ type: "saveVersion" });
  await refreshVersions();
}, fail));
$("version-download").addEventListener("click", (e) => {
  const v = chosen();
  if (!v)
    return;
  busy(e.currentTarget, "…", async () => {
    const text = await call({ type: "downloadVersion", id: v.id });
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    h("a", { href: url, download: `dulieu-${v.day}-${new Date(v.at).toTimeString().slice(0, 5).replace(":", "")}.txt` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, fail);
});
$("version-delete").addEventListener("click", (e) => {
  const v = chosen();
  if (!v || !confirm(`Delete the version from ${when(v)}? This cannot be undone.`))
    return;
  busy(e.currentTarget, "Deleting…", async () => {
    await call({ type: "deleteVersion", id: v.id });
    await refreshVersions();
  }, fail);
});
$("version-restore").addEventListener("click", (e) => {
  const v = chosen();
  if (!v)
    return;
  const question = `Restore the version from ${when(v)}${what(v) ? ` (${what(v).replace(" · ", ", ")})` : ""}?

` + "Reading history and names in every browser on this account are replaced by it. The data it replaces stays as a version.";
  if (!confirm(question))
    return;
  busy(e.currentTarget, "Restoring…", async () => {
    await call({ type: "restoreVersion", id: v.id });
    await refreshVersions();
  }, fail);
});
var timer;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !Object.keys(changes).some((k) => k === "settings" || k.startsWith("remote:")))
    return;
  clearTimeout(timer);
  timer = setTimeout(() => void refreshVersions(), 1000);
});
document.addEventListener("visibilitychange", () => !document.hidden && void refreshVersions());
setInterval(() => !document.hidden && void refreshVersions(), 60000);
refreshVersions();

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

// src/ui/options.ts
themeToggle(document.getElementById("theme"));
var $2 = (id) => document.getElementById(id);
var msg = (text, bad = false) => {
  const el = $2("msg");
  el.textContent = text;
  el.className = bad ? "error" : "muted";
};
async function render2() {
  const s = await getSettings();
  const list = await Promise.all(s.domains.map(async (d) => {
    const granted = await chrome.permissions.contains({ origins: domainPatterns([d]) });
    return h("li", {}, h("span", {}, d, granted ? null : h("small", { class: "error" }, " — access not granted")), h("button", { class: "link danger", onclick: () => void removeDomain(d) }, "Remove"));
  }));
  $2("domains").replaceChildren(...list);
}
function normalize(input) {
  let host = input.trim().toLowerCase();
  try {
    if (host.includes("/"))
      host = new URL(host.includes("://") ? host : `https://${host}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  return /^(?:[a-z0-9-]+\.)+[a-z0-9-]{2,}$/.test(host) ? host : null;
}
$2("add-domain").addEventListener("submit", async (e) => {
  e.preventDefault();
  const d = normalize($2("domain").value);
  if (!d)
    return msg("That does not look like a domain.", true);
  const granted = await chrome.permissions.request({ origins: domainPatterns([d]) });
  if (!granted)
    return msg(`Access to ${d} was not granted.`, true);
  await updateSettings((s) => ({ domains: s.domains.includes(d) ? s.domains : [...s.domains, d] }));
  $2("domain").value = "";
  await call({ type: "settingsChanged" });
  msg(`${d} added. Open it once to sync its data.`);
  await render2();
});
async function removeDomain(d) {
  if (!confirm(`Stop syncing ${d}? Its data in the browser and in Drive stays.`))
    return;
  await updateSettings((s) => ({ domains: s.domains.filter((x) => x !== d) }));
  if (!DEFAULT_DOMAINS.includes(d))
    await chrome.permissions.remove({ origins: domainPatterns([d]) }).catch(() => false);
  await call({ type: "settingsChanged" });
  await render2();
}
var status2;
var listed;
var listError = "";
var editing;
var dialog2 = $2("browser");
async function refreshBrowsers() {
  try {
    status2 = await call({ type: "status" });
    const sub = status2.active;
    listed = sub ? { sub, devices: await call({ type: "devices" }) } : undefined;
    listError = "";
  } catch (e) {
    listError = e instanceof Error ? e.message : String(e);
  }
  await renderBrowsers(false);
}
async function renderBrowsers(fetch = true) {
  try {
    if (fetch || !status2)
      status2 = await call({ type: "status" });
  } catch (e) {
    listError = e instanceof Error ? e.message : String(e);
  }
  const s = status2;
  const account = s?.accounts.find((a) => a.sub === s.active);
  const note = $2("browsers-note");
  note.className = "muted small";
  note.textContent = account ? `Browsers syncing with ${account.email}. Click one to rename or remove it.` : "Connect a Google account in the popup to list your other browsers.";
  if (listError)
    note.append(h("span", { class: "error" }, ` ${listError}`));
  if (!s)
    return;
  const remote = account?.linked ? s.devices : listed?.sub === account?.sub ? listed?.devices ?? [] : [];
  const self = { ...s.device, ...remote.find((d) => d.self), name: s.device.name, self: true };
  const others = remote.filter((d) => !d.self).sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
  const row = (d, onDrive) => h("li", {}, h("button", { type: "button", onclick: () => openBrowser(d, onDrive) }, h("span", {}, d.name, d.self ? h("small", { class: "muted" }, " (this browser)") : null), h("small", { class: "muted" }, onDrive ? `updated ${ago(d.updated)}` : account ? "not synced yet" : "")));
  $2("browsers").replaceChildren(row(self, remote.some((d) => d.self)), ...others.map((d) => row(d, true)));
}
function openBrowser(device, onDrive) {
  editing = { device, onDrive };
  $2("browser-title").textContent = device.self ? "This browser" : device.name;
  $2("browser-name").value = device.name;
  $2("browser-info").textContent = `Browser id: ${device.id}${onDrive ? ` · updated ${ago(device.updated)}` : ""}`;
  $2("browser-error").textContent = "";
  const remove = $2("browser-remove");
  remove.hidden = !onDrive || !status2?.active;
  remove.textContent = device.self ? "Remove this browser" : "Remove";
  dialog2.showModal();
}
var dialogError = (e) => $2("browser-error").textContent = e;
$2("browser-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!editing)
    return;
  const { device } = editing;
  const name = $2("browser-name").value.trim();
  if (name === device.name)
    return dialog2.close();
  busy($2("browser-save"), "Saving…", async () => {
    await call({ type: "renameDevice", id: device.id, name });
    dialog2.close();
    await refreshBrowsers();
  }, dialogError);
});
$2("browser-remove").addEventListener("click", () => {
  if (!editing)
    return;
  const { device } = editing;
  const email = status2?.accounts.find((a) => a.sub === status2?.active)?.email ?? "this account";
  const question = device.self ? `Remove this browser from ${email}?

It stops syncing. Its reading history and names stay here and in Drive.` : `Remove "${device.name}" from ${email}?

What it already synced stays. That browser stops syncing with this account until it is linked again from its popup.`;
  if (!confirm(question))
    return;
  busy($2("browser-remove"), "Removing…", async () => {
    await call({ type: "removeDevice", id: device.id });
    dialog2.close();
    await refreshBrowsers();
  }, dialogError);
});
$2("browser-cancel").addEventListener("click", () => dialog2.close());
dialog2.addEventListener("click", (e) => e.target === dialog2 && dialog2.close());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local")
    return;
  const keys = Object.keys(changes);
  if (keys.includes("settings"))
    refreshBrowsers();
  else if (keys.some((k) => k === "device" || k.startsWith("remote:") || k.startsWith("status:")))
    renderBrowsers();
});
document.addEventListener("visibilitychange", () => !document.hidden && void refreshBrowsers());
setInterval(() => !document.hidden && void refreshBrowsers(), 60000);
render2();
refreshBrowsers();
