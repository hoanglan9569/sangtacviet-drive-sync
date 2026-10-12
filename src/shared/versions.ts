/**
 * Versions: dulieu.txt's own revisions in Drive (its version history), one per
 * change, kept forever like Drive's "Keep forever". Drive keeps at most 200 per
 * file, so past KEEP_FOREVER the oldest become temporary again and Drive deletes
 * them in its own time. A joining browser's own data, and versions saved by older
 * releases, are separate files (stvSync = backup).
 */
import type { DriveFile, Revision } from "./drive";

/** Revisions kept forever; Drive allows 200 per file, this leaves room for the next upload. */
export const KEEP_FOREVER = 180;

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
  /** A revision not kept forever: Drive deletes it 30 days after a newer one, or sooner past 100. */
  temporary?: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

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

/** The revisions to make temporary again: the kept-forever ones past the newest KEEP_FOREVER. Never the latest. */
export function toRelease(versions: Version[]): Version[] {
  return versions
    .filter((v) => v.id.startsWith("rev:") && !v.temporary)
    .sort(byNewest)
    .slice(KEEP_FOREVER)
    .filter((v) => !v.current);
}