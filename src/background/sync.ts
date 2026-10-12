/**
 * When to sync, and against which tab. Every sangtacviet origin open in a tab
 * is a replica; pages report their storage writes ("dirty") and page loads
 * ("hello"), and an alarm pulls other browsers' changes every few minutes.
 * Runs are serialized: one sync at a time.
 */
import { Drive, DRIVE_BASE } from "../shared/drive";
import { type Replica, SyncEngine } from "../shared/engine";
import type { ApplyReply, BackgroundToContent, ReadReply } from "../shared/messages";
import { AuthError, tokenFor } from "./auth";
import { type Settings, domainPatterns, getSettings, local, matchesDomain, setAccountStatus } from "./settings";

export function engineFor(s: Settings, sub: string): SyncEngine {
  const account = s.accounts.find((a) => a.sub === sub);
  if (!account) throw new Error("Unknown account");
  const drive = new Drive((stale) => tokenFor(account, stale), s.driveBase || DRIVE_BASE);
  return new SyncEngine(local, drive, sub, s.device);
}

const timesKey = (origin: string) => `times:${origin}`;

/** Remembers when the page wrote a key, so the change is dated by the write, not by the sync. */
export async function recordWrite(origin: string, key: string, t: number): Promise<void> {
  const k = timesKey(origin);
  const times = ((await chrome.storage.session.get(k))[k] as Record<string, number> | undefined) ?? {};
  times[key] = Math.max(times[key] ?? 0, t);
  await chrome.storage.session.set({ [k]: times });
}

async function send<T>(tabId: number, msg: BackgroundToContent): Promise<T> {
  return chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }) as Promise<T>;
}

async function openTabs(domains: string[]): Promise<Map<string, number>> {
  const byOrigin = new Map<string, number>();
  const tabs = await chrome.tabs.query({ url: domainPatterns(domains) });
  for (const t of tabs) {
    if (t.id == null || !matchesDomain(t.url, domains) || t.discarded) continue;
    const origin = new URL(t.url!).origin;
    if (!byOrigin.has(origin) || t.active) byOrigin.set(origin, t.id);
  }
  return byOrigin;
}

function tabReplica(origin: string, tabId: number, hosts: string[]): Replica {
  return {
    origin,
    read: () => send<ReadReply>(tabId, { type: "read", hosts }),
    async apply(plan) {
      const r = await send<ApplyReply>(tabId, { type: "apply", plan });
      if (r.error) throw new Error(`Could not write to ${origin}: ${r.error}`);
      return r.ok;
    },
  };
}

let syncing = false;
export const isSyncing = () => syncing;
let chain: Promise<void> = Promise.resolve();
const pending = new Map<string, number | undefined>();
let timer: ReturnType<typeof setTimeout> | undefined;

/** Sync `origin` soon (debounced); with no origin, every open sangtacviet origin. */
export function schedule(origin?: string, tabId?: number, delay = 1500): void {
  pending.set(origin ?? "*", tabId);
  clearTimeout(timer);
  timer = setTimeout(() => void run(), delay);
}

/** Sync every open origin right away; resolves when done. */
export function syncAllNow(): Promise<void> {
  pending.set("*", undefined);
  clearTimeout(timer);
  return run();
}

function run(): Promise<void> {
  const jobs = new Map(pending);
  pending.clear();
  chain = chain.then(() => runJobs(jobs)).catch((e) => console.error(e));
  return chain;
}

async function runJobs(jobs: Map<string, number | undefined>): Promise<void> {
  if (jobs.size === 0) return;
  const s = await getSettings();
  const sub = s.active;
  if (!sub || !s.linked[sub]) return;
  const engine = engineFor(s, sub);
  const tabs = await openTabs(s.domains);
  const targets = jobs.has("*") ? new Map(tabs) : new Map<string, number>();
  for (const [origin, tabId] of jobs) {
    if (origin === "*") continue;
    const id = tabs.get(origin) ?? tabId;
    if (id != null) targets.set(origin, id);
  }
  syncing = true;
  await chrome.runtime.sendMessage({ type: "changed" }).catch(() => {});
  try {
    if (targets.size === 0) await engine.sync();
    for (const [origin, tabId] of targets) {
      const started = Date.now();
      const k = timesKey(origin);
      const times = ((await chrome.storage.session.get(k))[k] as Record<string, number> | undefined) ?? {};
      try {
        await engine.sync(tabReplica(origin, tabId, s.hosts), times);
      } catch (e) {
        // A tab that closed or has no content script yet is not an error worth showing.
        if (/Receiving end does not exist|No tab with id|message port closed/i.test(String(e))) continue;
        throw e;
      }
      const left = Object.fromEntries(Object.entries(times).filter(([, t]) => t > started));
      await chrome.storage.session.set({ [k]: left });
    }
    await setAccountStatus(sub, { lastSync: Date.now(), lastError: undefined });
    await chrome.alarms.clear("retry");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await setAccountStatus(sub, { lastError: message });
    if (!(e instanceof AuthError)) await chrome.alarms.create("retry", { delayInMinutes: 1 });
  } finally {
    syncing = false;
    await updateBadge();
    await chrome.runtime.sendMessage({ type: "changed" }).catch(() => {});
  }
}

export async function updateBadge(): Promise<void> {
  const s = await getSettings();
  const st = s.active ? (((await local.get<{ lastError?: string; needsAuth?: boolean }>(`status:${s.active}`)) ?? {})) : {};
  const bad = !!s.active && s.linked[s.active] && (st.needsAuth || !!st.lastError);
  await chrome.action.setBadgeText({ text: bad ? "!" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
}

export async function openTabCount(): Promise<number> {
  return (await openTabs((await getSettings()).domains)).size;
}
