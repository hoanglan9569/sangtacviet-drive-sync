import { DEFAULT_DOMAINS, domainPatterns, getSettings, updateSettings } from "../background/settings";
import type { RemoteDevice } from "../shared/engine";
import type { Status } from "../shared/messages";
import { ago, busy, call, h } from "./common";
import "./backups";
import { themeToggle } from "./theme";

themeToggle(document.getElementById("theme")!);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const msg = (text: string, bad = false) => {
  const el = $("msg");
  el.textContent = text;
  el.className = bad ? "error" : "muted";
};

async function render(): Promise<void> {
  const s = await getSettings();
  $<HTMLInputElement>("client-id").value = s.clientId;
  $<HTMLInputElement>("redirect").value = chrome.identity.getRedirectURL();
  const list = await Promise.all(
    s.domains.map(async (d) => {
      const granted = await chrome.permissions.contains({ origins: domainPatterns([d]) });
      return h(
        "li",
        {},
        h("span", {}, d, granted ? null : h("small", { class: "error" }, " — access not granted")),
        h("button", { class: "link danger", onclick: () => void removeDomain(d) }, "Remove"),
      );
    }),
  );
  $("domains").replaceChildren(...list);
}

/** "https://www.SangTacViet.vip/abc" -> "sangtacviet.vip" */
function normalize(input: string): string | null {
  let host = input.trim().toLowerCase();
  try {
    if (host.includes("/")) host = new URL(host.includes("://") ? host : `https://${host}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  return /^(?:[a-z0-9-]+\.)+[a-z0-9-]{2,}$/.test(host) ? host : null;
}

$("add-domain").addEventListener("submit", async (e) => {
  e.preventDefault();
  const d = normalize($<HTMLInputElement>("domain").value);
  if (!d) return msg("That does not look like a domain.", true);
  // Must run inside the click: Chrome only shows the permission prompt for a user gesture.
  const granted = await chrome.permissions.request({ origins: domainPatterns([d]) });
  if (!granted) return msg(`Access to ${d} was not granted.`, true);
  await updateSettings((s) => ({ domains: s.domains.includes(d) ? s.domains : [...s.domains, d] }));
  $<HTMLInputElement>("domain").value = "";
  await call({ type: "settingsChanged" });
  msg(`${d} added. Open it once to sync its data.`);
  await render();
});

async function removeDomain(d: string): Promise<void> {
  if (!confirm(`Stop syncing ${d}? Its data in the browser and in Drive stays.`)) return;
  await updateSettings((s) => ({ domains: s.domains.filter((x) => x !== d) }));
  if (!DEFAULT_DOMAINS.includes(d)) await chrome.permissions.remove({ origins: domainPatterns([d]) }).catch(() => false);
  await call({ type: "settingsChanged" });
  await render();
}

$("client").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $<HTMLInputElement>("client-id").value.trim();
  if (id && !/\.apps\.googleusercontent\.com$/.test(id)) return msg("A client ID ends with .apps.googleusercontent.com", true);
  await updateSettings(() => ({ clientId: id }));
  msg("Client ID saved.");
});

$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($<HTMLInputElement>("redirect").value);
  msg("Redirect URI copied.");
});

// Browsers on the selected account: listed from Drive; a click opens a dialog to rename or remove one.
let status: Status | undefined;
/** Last Drive listing, for an account that does not sync here (a synced one keeps its list in status). */
let listed: { sub: string; devices: RemoteDevice[] } | undefined;
let listError = "";
let editing: { device: RemoteDevice; onDrive: boolean } | undefined;
const dialog = $<HTMLDialogElement>("browser");

/** Lists the browsers from Drive again, then redraws. */
async function refreshBrowsers(): Promise<void> {
  try {
    status = await call<Status>({ type: "status" });
    const sub = status.active;
    listed = sub ? { sub, devices: await call<RemoteDevice[]>({ type: "devices" }) } : undefined;
    listError = "";
  } catch (e) {
    listError = e instanceof Error ? e.message : String(e);
  }
  await renderBrowsers(false);
}

async function renderBrowsers(fetch = true): Promise<void> {
  try {
    if (fetch || !status) status = await call<Status>({ type: "status" });
  } catch (e) {
    listError = e instanceof Error ? e.message : String(e);
  }
  const s = status;
  const account = s?.accounts.find((a) => a.sub === s.active);
  const note = $("browsers-note");
  note.className = "muted small";
  note.textContent = account ? `Browsers syncing with ${account.email}. Click one to rename or remove it.` : "Connect a Google account in the popup to list your other browsers.";
  if (listError) note.append(h("span", { class: "error" }, ` ${listError}`));
  if (!s) return;

  const remote = account?.linked ? s.devices : listed?.sub === account?.sub ? (listed?.devices ?? []) : [];
  const self: RemoteDevice = { ...s.device, ...remote.find((d) => d.self), name: s.device.name, self: true };
  const others = remote.filter((d) => !d.self).sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
  const row = (d: RemoteDevice, onDrive: boolean) =>
    h(
      "li",
      {},
      h(
        "button",
        { type: "button", onclick: () => openBrowser(d, onDrive) },
        h("span", {}, d.name, d.self ? h("small", { class: "muted" }, " (this browser)") : null),
        h("small", { class: "muted" }, onDrive ? `updated ${ago(d.updated)}` : account ? "not synced yet" : ""),
      ),
    );
  $("browsers").replaceChildren(row(self, remote.some((d) => d.self)), ...others.map((d) => row(d, true)));
}

function openBrowser(device: RemoteDevice, onDrive: boolean): void {
  editing = { device, onDrive };
  $("browser-title").textContent = device.self ? "This browser" : device.name;
  $<HTMLInputElement>("browser-name").value = device.name;
  $("browser-info").textContent = `Browser id: ${device.id}${onDrive ? ` · updated ${ago(device.updated)}` : ""}`;
  $("browser-error").textContent = "";
  const remove = $<HTMLButtonElement>("browser-remove");
  remove.hidden = !onDrive || !status?.active;
  remove.textContent = device.self ? "Remove this browser" : "Remove";
  dialog.showModal();
}

const dialogError = (e: string) => ($("browser-error").textContent = e);

$("browser-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!editing) return;
  const { device } = editing;
  const name = $<HTMLInputElement>("browser-name").value.trim();
  if (name === device.name) return dialog.close();
  void busy($<HTMLButtonElement>("browser-save"), "Saving…", async () => {
    await call({ type: "renameDevice", id: device.id, name });
    dialog.close();
    await refreshBrowsers();
  }, dialogError);
});

$("browser-remove").addEventListener("click", () => {
  if (!editing) return;
  const { device } = editing;
  const email = status?.accounts.find((a) => a.sub === status?.active)?.email ?? "this account";
  const question = device.self
    ? `Remove this browser from ${email}?\n\nIt stops syncing. Its reading history and names stay here and in Drive.`
    : `Remove "${device.name}" from ${email}?\n\nWhat it already synced stays. That browser stops syncing with this account until it is linked again from its popup.`;
  if (!confirm(question)) return;
  void busy($<HTMLButtonElement>("browser-remove"), "Removing…", async () => {
    await call({ type: "removeDevice", id: device.id });
    dialog.close();
    await refreshBrowsers();
  }, dialogError);
});

$("browser-cancel").addEventListener("click", () => dialog.close());
// A click on the backdrop lands on the dialog itself.
dialog.addEventListener("click", (e) => e.target === dialog && dialog.close());

// Keep the list current: sync and the popup change these keys; Drive is listed again on focus and every minute.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const keys = Object.keys(changes);
  if (keys.includes("settings")) void refreshBrowsers();
  else if (keys.some((k) => k === "device" || k.startsWith("remote:") || k.startsWith("status:"))) void renderBrowsers();
});
document.addEventListener("visibilitychange", () => !document.hidden && void refreshBrowsers());
setInterval(() => !document.hidden && void refreshBrowsers(), 60_000);

void render();
void refreshBrowsers();
