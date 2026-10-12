import { DEFAULT_DOMAINS, domainPatterns, getSettings, updateSettings } from "../background/settings";
import { call, h } from "./common";

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
  $<HTMLInputElement>("device-name").value = s.device.name;
  $("device-id").textContent = `Browser id: ${s.device.id}`;
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

$("device").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $<HTMLInputElement>("device-name").value.trim();
  if (!name) return;
  const { device } = await getSettings();
  await chrome.storage.local.set({ device: { ...device, name } });
  msg("Saved. Other browsers see the new name after this browser's next change.");
});

void render();
