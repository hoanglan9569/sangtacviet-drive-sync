import type { ContentToBackground, Reply, Status, UiRequest } from "../shared/messages";
import { addAccount, reconnect, signOut } from "./auth";
import { registerContentScripts } from "./scripts";
import { getAccountStatus, getSettings, local, matchesDomain, setAccountStatus, updateSettings } from "./settings";
import { engineFor, isSyncing, openTabCount, recordWrite, schedule, syncAllNow, updateBadge } from "./sync";
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
    counts: s.active ? await engineFor(s, s.active).stats() : undefined,
    devices: remote?.devices ?? [],
    openTabs: await openTabCount(),
  };
}
