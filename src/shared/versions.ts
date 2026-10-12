/**
 * Versions: dulieu.txt's own revisions in Drive (its version history),
 * one per change, kept forever until the policy drops them. A joining browser's
 * own data, and versions saved by older releases, are separate files (stvSync = backup).
 * The policy (versions per day, saved days kept) lives on the sync folder, so
 * every browser on the account follows the same one.
 */
import type { DriveFile, Revision } from "./drive";

export interface VersionPolicy {
  /** Newest versions kept per day. */
  perDay: number;
  /** Days kept, counting only days that have versions: gaps with nothing saved do not count. */
  days: number;
}

export const DEFAULT_POLICY: VersionPolicy = { perDay: 2, days: 7 };
export const POLICY_LIMITS: Record<keyof VersionPolicy, [min: number, max: number]> = { perDay: [1, 24], days: [1, 365] };
/** Drive keeps at most 200 revisions of a file forever; this leaves room for the next upload. */
export const MAX_VERSIONS = 180;
/** "join": a browser's own data from before it joined the account, where the account's data won. */
export type VersionReason = "auto" | "manual" | "restore" | "join";

export interface Version {
  /** A file id, or `rev:<file id>:<revision id>` for a revision of dulieu.txt. */
  id: string;
  /** When it was saved (ms). */
  at: number;
  /** Local day it belongs to, YYYY-MM-DD. */
  day: string;
  deviceName: string;
  /** Unknown (undefined) when Drive did not keep the revision's file name. */
  books?: number;
  names?: number;
  /** Bytes. */
  size?: number;
  reason: VersionReason;
  /** dulieu.txt's current content: Drive does not delete that one. */
  current?: boolean;
  /** A revision not kept forever: Drive deletes it 30 days after a newer one, or sooner past 100. The policy leaves these to Drive. */
  temporary?: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function clampPolicy(p: Partial<VersionPolicy>): VersionPolicy {
  const one = (k: keyof VersionPolicy) => {
    const [min, max] = POLICY_LIMITS[k];
    const n = Math.round(Number(p[k]));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : DEFAULT_POLICY[k];
  };
  const perDay = one("perDay");
  return { perDay, days: Math.min(one("days"), Math.floor(MAX_VERSIONS / perDay)) };
}

/** The policy stored on the sync folder's appProperties. */
export function policyFrom(props: Record<string, string> | undefined): VersionPolicy {
  return clampPolicy({ perDay: Number(props?.backupPerDay ?? DEFAULT_POLICY.perDay), days: Number(props?.backupDays ?? DEFAULT_POLICY.days) });
}

export const policyProps = (p: VersionPolicy): Record<string, string> => ({ backupPerDay: String(p.perDay), backupDays: String(p.days) });

export function versionFrom(f: DriveFile): Version {
  const a = f.appProperties ?? {};
  const at = Number(a.at) || Date.parse(f.createdTime ?? "") || 0;
  return {
    id: f.id,
    at,
    day: a.day ?? dayOf(at),
    deviceName: a.deviceName ?? "",
    books: Number(a.books) || 0,
    names: Number(a.names) || 0,
    reason: a.reason === "manual" || a.reason === "restore" || a.reason === "join" ? a.reason : "auto",
  };
}

/** The file name a revision is uploaded with: it carries what the version holds, also for Drive's own version list. */
export const revisionName = (deviceName: string, books: number, names: number) => `dulieu - ${deviceName} - ${books} books, ${names} names.txt`;

export const revisionId = (fileId: string, revId: string) => `rev:${fileId}:${revId}`;

/** The file and revision a version id names, if it is a revision. */
export function parseRevisionId(id: string): { fileId: string; revId: string } | undefined {
  const m = /^rev:([^:]+):(.+)$/.exec(id);
  return m ? { fileId: m[1]!, revId: m[2]! } : undefined;
}

export function versionFromRevision(fileId: string, r: Revision, current: boolean): Version {
  const at = Date.parse(r.modifiedTime ?? "") || 0;
  const m = /^dulieu - (.*) - (\d+) books, (\d+) names\.txt$/.exec(r.originalFilename ?? "");
  return {
    id: revisionId(fileId, r.id),
    at,
    day: dayOf(at),
    deviceName: m?.[1] ?? "",
    books: m ? Number(m[2]) : undefined,
    names: m ? Number(m[3]) : undefined,
    size: r.size === undefined ? undefined : Number(r.size),
    reason: "auto",
    current,
    temporary: !r.keepForever,
  };
}

/** Newest first. */
export const byNewest = (a: Version, b: Version) => b.at - a.at;

/**
 * The versions the policy drops. Each saved day keeps its `perDay` newest, and only the
 * `days` most recent days that have versions are kept, however far apart they are: with
 * 2 a day and 7 days, at most 14 versions remain. "join" versions neither count toward a
 * day's versions nor make a day count; they go with their day. Temporary revisions are
 * left to Drive.
 */
export function toPrune(versions: Version[], policy: VersionPolicy): Version[] {
  const sorted = versions.filter((v) => !v.temporary).sort(byNewest);
  const days = [...new Set(sorted.filter((v) => v.reason !== "join").map((v) => v.day))].sort().reverse();
  const oldest = days.length > policy.days ? days[policy.days - 1]! : "";
  const perDay = new Map<string, number>();
  return sorted.filter((v) => {
    if (v.day < oldest) return true;
    if (v.reason === "join") return false;
    const n = (perDay.get(v.day) ?? 0) + 1;
    perDay.set(v.day, n);
    return n > policy.perDay;
  });
}
