import type { Device, KV } from "../shared/engine";
import type { Account } from "../shared/messages";

export const DEFAULT_DOMAINS = ["sangtacviet.com", "sangtacviet.app"];
/** Baked in at build time from $env:STV_GOOGLE_CLIENT_ID; the Settings page can override it. */
declare const __CLIENT_ID__: string;

export interface Settings {
  clientId: string;
  device: Device;
  domains: string[];
  accounts: Account[];
  active?: string;
  linked: Record<string, boolean>;
  /** Extra name-key prefixes reported by pages (window.hmeta). */
  hosts: string[];
  /** Test hook: point Drive calls at a fake server. */
  driveBase?: string;
}

export interface AccountStatus {
  lastSync?: number;
  lastError?: string;
  needsAuth?: boolean;
  notice?: string;
}

export const local: KV = {
  async get<T>(key: string) {
    return (await chrome.storage.local.get(key))[key] as T | undefined;
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(key) {
    await chrome.storage.local.remove(key);
  },
};

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : "Chrome";
  return `${browser}${os ? ` on ${os}` : ""}`;
}

let deviceInit: Promise<Settings["device"]> | undefined;

/** This browser's id is made once, on first use, and kept for good (under its own key, so it never races a settings write). */
function ensureDevice(): Promise<Settings["device"]> {
  deviceInit ??= (async () => {
    const stored = await local.get<Settings["device"]>("device");
    if (stored) return stored;
    const device = { id: crypto.randomUUID().slice(0, 8), name: defaultDeviceName() };
    await local.set("device", device);
    return device;
  })();
  return deviceInit;
}

export async function getSettings(): Promise<Settings> {
  const s = (await local.get<Partial<Settings>>("settings")) ?? {};
  return {
    clientId: s.clientId || (typeof __CLIENT_ID__ === "string" ? __CLIENT_ID__ : ""),
    device: (await local.get<Settings["device"]>("device")) ?? (await ensureDevice()),
    domains: s.domains ?? DEFAULT_DOMAINS,
    accounts: s.accounts ?? [],
    active: s.active,
    linked: s.linked ?? {},
    hosts: s.hosts ?? [],
    driveBase: s.driveBase,
  };
}

/** Read-modify-write of the stored settings; only the fields `fn` returns change. */
export async function updateSettings(fn: (s: Settings) => Partial<Settings>): Promise<Settings> {
  const raw = (await local.get<Partial<Settings>>("settings")) ?? {};
  const next = { ...raw, ...fn(await getSettings()) };
  await local.set("settings", next);
  return getSettings();
}

export async function getAccountStatus(sub: string): Promise<AccountStatus> {
  return (await local.get<AccountStatus>(`status:${sub}`)) ?? {};
}

export async function setAccountStatus(sub: string, patch: AccountStatus): Promise<void> {
  await local.set(`status:${sub}`, { ...(await getAccountStatus(sub)), ...patch });
}

export function domainPatterns(domains: string[]): string[] {
  return domains.flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]);
}

export function matchesDomain(url: string | undefined, domains: string[]): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return domains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}
