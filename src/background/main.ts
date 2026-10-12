import type { ContentToBackground, Reply, Status, UiRequest } from "../shared/messages";
import { addAccount, reconnect, signOut } from "./auth";
import { registerContentScripts } from "./scripts";
import { type Settings, getAccountStatus, getSettings, local, matchesDomain, setAccountStatus, updateSettings } from "./settings";
import { detach, engineFor, isSyncing, openTabCount, recordWrite, schedule, serialized, syncAllNow, updateBadge } from "./sync";
import type { RemoteDevice } from "../shared/engine";

const PERIOD_MIN = 5;

chrome.runtime.onInstalled.addListener(() => void setup());
chrome.runtime.onStartup.addListener(() => void setup());

async function setup(): Promise<void> {
  await getSettings();
  await registerContentScripts();
  await chrome.alarms.create("pull", { periodInMinutes: PERIOD_MIN });
  await updateBadge();
  schedule(undefined, undefined, 3000);
}

chrome.alarms.onAlarm.addListener(() => schedule(undefined, undefined, 0));

chrome.runtime.onMessage.addListener((msg: ContentToBackground | UiRequest, sender, reply) => {
  // The options page also runs in a tab, so tell pages apart by URL, not by sender.tab.
  if (!sender.url?.startsWith(chrome.runtime.getURL(""))) {
    void fromPage(msg as ContentToBackground, sender);
    return false;
  }
  handleUi(msg as UiRequest).then(
    (value) => reply({ ok: true, value } satisfies Reply),
    (e: unknown) => reply({ ok: false, error: e instanceof Error ? e.message : String(e) } satisfies Reply),
  );
  return true;
});

async function fromPage(msg: ContentToBackground, sender: chrome.runtime.MessageSender): Promise<void> {
  if (sender.frameId !== 0 || !sender.tab?.id) return;
  const s = await getSettings();
  if (!matchesDomain(sender.url, s.domains)) return;
  const origin = new URL(sender.url!).origin;
  if (msg.type === "hosts") {
    const extra = msg.hosts.filter((h) => typeof h === "string" && h && !s.hosts.includes(h));
    if (extra.length) await updateSettings((cur) => ({ hosts: [...cur.hosts, ...extra] }));
    return;
  }
  if (!s.active || !s.linked[s.active]) return;
  if (msg.type === "dirty") {
    await recordWrite(origin, msg.key, msg.t);
    schedule(origin, sender.tab.id, 2000);
  } else if (msg.type === "hello") {
    schedule(origin, sender.tab.id, 500);
  }
}

async function handleUi(msg: UiRequest): Promise<unknown> {
  const s = await getSettings();
  const active = s.active;
  switch (msg.type) {
    case "status":
      return status();
    case "summary":
      if (!active) throw new Error("No account selected");
      return engineFor(s, active).summary();
    case "addAccount": {
      const a = await addAccount();
      await updateBadge();
      return a;
    }
    case "reconnect": {
      const a = s.accounts.find((x) => x.sub === msg.sub);
      if (!a) throw new Error("Unknown account");
      await reconnect(a);
      schedule();
      return null;
    }
    case "removeAccount": {
      if (s.accounts.some((a) => a.sub === msg.sub)) await engineFor(s, msg.sub).forget();
      await signOut(msg.sub);
      await local.remove(`status:${msg.sub}`);
      await updateSettings((cur) => {
        const accounts = cur.accounts.filter((a) => a.sub !== msg.sub);
        const { [msg.sub]: _gone, ...linked } = cur.linked;
        return { accounts, linked, active: cur.active === msg.sub ? accounts[0]?.sub : cur.active };
      });
      await updateBadge();
      return null;
    }
    case "setActive":
      await updateSettings(() => ({ active: msg.sub }));
      await updateBadge();
      schedule(undefined, undefined, 0);
      return null;
    case "link":
      if (!active) throw new Error("No account selected");
      await setAccountStatus(active, { notice: undefined });
      await updateSettings((cur) => ({ linked: { ...cur.linked, [active]: true } }));
      await syncAllNow();
      return status();
    case "unlink":
      if (!active) throw new Error("No account selected");
      await updateSettings((cur) => ({ linked: { ...cur.linked, [active]: false } }));
      await setAccountStatus(active, { lastError: undefined });
      await updateBadge();
      return null;
    case "syncNow":
      await syncAllNow();
      return status();
    case "export":
      if (!active) throw new Error("No account selected");
      return engineFor(s, active).exportText();
    case "devices":
      return active ? serialized(() => engineFor(s, active).listDevices()) : [];
    case "renameDevice": {
      const name = msg.name.trim().slice(0, 60);
      if (!name) throw new Error("Enter a name");
      const at = Date.now();
      if (msg.id === s.device.id) await local.set("device", { ...s.device, name, nameAt: at });
      else if (!active) throw new Error("No account selected");
      if (active) await serialized(() => engineFor(s, active).renameDevice(msg.id, name, at));
      await changed();
      return null;
    }
    case "removeDevice":
      if (!active) throw new Error("No account selected");
      await serialized(() => engineFor(s, active).removeDevice(msg.id));
      if (msg.id === s.device.id) await detach(s, active);
      await updateBadge();
      await changed();
      return null;
    case "versions":
      if (!active) throw new Error("No account selected");
      return serialized(() => engineFor(s, active).versions());
    case "saveVersion":
      return serialized(() => linkedEngine(s).saveVersion());

    case "deleteVersion":
      if (!active) throw new Error("No account selected");
      return serialized(() => engineFor(s, active).deleteVersion(msg.id));
    case "downloadVersion":
      if (!active) throw new Error("No account selected");
      return engineFor(s, active).downloadVersion(msg.id);
    case "restoreVersion":
      await serialized(() => linkedEngine(s).restoreVersion(msg.id));
      await syncAllNow(); // writes the restored data into open pages
      await changed();
      return null;
    case "settingsChanged":
      await registerContentScripts();
      schedule();
      return null;
  }
}

async function status(): Promise<Status> {
  const s = await getSettings();
  const accounts = await Promise.all(
    s.accounts.map(async (a) => ({ ...a, needsAuth: !!(await getAccountStatus(a.sub)).needsAuth, linked: !!s.linked[a.sub] })),
  );
  const st = s.active ? await getAccountStatus(s.active) : {};
  const remote = s.active ? await local.get<{ devices?: RemoteDevice[] }>(`remote:${s.active}`) : undefined;
  return {
    clientId: !!s.clientId,
    redirectUri: chrome.identity.getRedirectURL(),
    device: s.device,
    domains: s.domains,
    accounts,
    active: s.active,
    syncing: isSyncing(),
    lastSync: st.lastSync,
    lastError: st.lastError,
    notice: st.notice,
    counts: s.active ? await engineFor(s, s.active).stats() : undefined,
    devices: remote?.devices ?? [],
    openTabs: await openTabCount(),
  };
}

/** Tells an open popup to redraw. */
async function changed(): Promise<void> {
  await chrome.runtime.sendMessage({ type: "changed" }).catch(() => {});
}

/** The engine of the selected account, which must sync in this browser. */
function linkedEngine(s: Settings) {
  if (!s.active) throw new Error("No account selected");
  if (!s.linked[s.active]) throw new Error("Start syncing this account first.");
  return engineFor(s, s.active);
}
