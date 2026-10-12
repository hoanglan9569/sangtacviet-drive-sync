/**
 * Backup versions: copies of the account's merged data in the site's export
 * format, kept on Drive next to the device files (stvSync = backup). The
 * policy (versions per day, days kept) lives on the sync folder, so every
 * browser on the account follows the same one.
 */
import type { DriveFile } from "./drive";

export interface BackupPolicy {
  /** Newest versions kept per day. */
  perDay: number;
  /** Days kept, today included. */
  days: number;
}

export const DEFAULT_POLICY: BackupPolicy = { perDay: 2, days: 7 };
export const POLICY_LIMITS: Record<keyof BackupPolicy, [min: number, max: number]> = { perDay: [1, 24], days: [1, 365] };
/** While the data keeps changing, a new version is saved at most this often. */
export const BACKUP_GAP = 3600 * 1000;

export type BackupReason = "auto" | "manual" | "restore";

export interface BackupVersion {
  id: string;
  /** When it was saved (ms). */
  at: number;
  /** Local day it belongs to, YYYY-MM-DD. */
  day: string;
  deviceName: string;
  books: number;
  names: number;
  hash: string;
  reason: BackupReason;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function clampPolicy(p: Partial<BackupPolicy>): BackupPolicy {
  const one = (k: keyof BackupPolicy) => {
    const [min, max] = POLICY_LIMITS[k];
    const n = Math.round(Number(p[k]));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : DEFAULT_POLICY[k];
  };
  return { perDay: one("perDay"), days: one("days") };
}

/** The policy stored on the sync folder's appProperties. */
export function policyFrom(props: Record<string, string> | undefined): BackupPolicy {
  return clampPolicy({ perDay: Number(props?.backupPerDay ?? DEFAULT_POLICY.perDay), days: Number(props?.backupDays ?? DEFAULT_POLICY.days) });
}

export const policyProps = (p: BackupPolicy): Record<string, string> => ({ backupPerDay: String(p.perDay), backupDays: String(p.days) });

export function versionFrom(f: DriveFile): BackupVersion {
  const a = f.appProperties ?? {};
  const at = Number(a.at) || Date.parse(f.createdTime ?? "") || 0;
  return {
    id: f.id,
    at,
    day: a.day ?? dayOf(at),
    deviceName: a.deviceName ?? "",
    books: Number(a.books) || 0,
    names: Number(a.names) || 0,
    hash: a.hash ?? "",
    reason: a.reason === "manual" || a.reason === "restore" ? a.reason : "auto",
  };
}

/** Newest first. */
export const byNewest = (a: BackupVersion, b: BackupVersion) => b.at - a.at;

/**
 * The versions the policy drops: each day keeps its `perDay` newest, and days
 * before the last `days` go. The newest version is always kept, so a browser
 * with a wrong clock cannot wipe every backup.
 */
export function toPrune(versions: BackupVersion[], policy: BackupPolicy, now: number): BackupVersion[] {
  const sorted = [...versions].sort(byNewest);
  const cutoff = dayOf(now - (policy.days - 1) * 86_400_000);
  const perDay = new Map<string, number>();
  return sorted.filter((v, i) => {
    const n = (perDay.get(v.day) ?? 0) + 1;
    perDay.set(v.day, n);
    return i > 0 && (v.day < cutoff || n > policy.perDay);
  });
}
