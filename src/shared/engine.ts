/**
 * One sync round for one Google account:
 *
 *   1. read the page's localStorage (a "replica": one sangtacviet origin open in a tab)
 *      and record what changed since its last sync
 *   2. merge the other browsers' changes from Drive
 *   3. upload what changed here: a small change file, not the whole data
 *   4. write the merged result back into the page — only if the page did not change
 *      meanwhile (compare-and-set), otherwise start over
 *   5. then, off the page's critical path: update dulieu.txt, whose Drive revisions are the versions
 *
 * Each browser keeps a device file (all its data, as of change number `upTo`) and
 * change files numbered after it (stvSync = ops). Every few dozen changes it folds
 * them into the device file. Others download only the change files they lack, and
 * the device file only when they fell further behind than the change files reach.
 * Each browser writes only its own files, so two browsers syncing at the same
 * moment cannot overwrite each other's changes on Drive.
 */
import { Drive, DriveError, type DriveFile, type FileMeta, type UploadOptions, quote } from "./drive";
import {
  type Items,
  type WritePlan,
  EMPTY,
  absorbLocal,
  applyPlan,
  buildSnapshot,
  counts,
  dropTombstones,
  isEmptyPlan,
  mergeItems,
  liveItems,
  planWrites,
  replaceWith,
  resolveTerms,
} from "./model";
import { type ExportFile, type Snapshot, fromExport, toExport } from "./sitedata";
import {
  type VersionPolicy,
  type VersionReason,
  type Version,
  byNewest,
  clampPolicy,
  dayOf,
  parseRevisionId,
  policyFrom,
  policyProps,
  revisionName,
  toPrune,
  versionFrom,
  versionFromRevision,
} from "./versions";

export const FOLDER_NAME = "SangTacViet Sync";
export const EXPORT_NAME = "dulieu.txt";
export const TOMBSTONE_TTL = 180 * 24 * 3600 * 1000;
const MAX_ATTEMPTS = 5;
/** Change files kept before they are folded into the device file. */
export const COMPACT_AT = 30;
/** A change touching more items than this rewrites the device file instead (a restore, a big import). */
const OPS_MAX_ITEMS = 1000;

export interface Replica {
  origin: string;
  /** `marked`: the page still holds MARK_KEY, i.e. its storage was not cleared since this extension synced it. */
  read(): Promise<{ snapshot: Snapshot; stamp?: number; marked: boolean }>;
  /** Writes `plan.set` if every key still holds its `plan.expect` value, and sets MARK_KEY; false when the page changed meanwhile. */
  apply(plan: WritePlan): Promise<boolean>;
}

export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface Device {
  id: string;
  name: string;
  /** When the name was last set (ms). A rename made in another browser wins when it is newer. */
  nameAt?: number;
}

/** This browser's device file was removed (from another browser): it no longer syncs with the account. */
export class DeviceRemovedError extends Error {}

type WireItems = Record<string, [t: number, v: string | null]>;

export interface DeviceFile {
  format: "stv-drive-sync/device";
  v: 1;
  device: Device;
  updated: number;
  /** The newest of this browser's change files the items include. Files of older versions have none and are rewritten whole on every change. */
  upTo?: number;
  items: WireItems;
}

/** The items one browser changed in one sync. */
export interface OpsFile {
  format: "stv-drive-sync/ops";
  v: 1;
  device: string;
  seq: number;
  items: WireItems;
}

interface AccountState {
  items: Items;
  rev: number;
}

export interface RemoteDevice {
  id: string;
  name: string;
  updated?: string;
  self: boolean;
}

interface RemoteState {
  folderId?: string;
  deviceFileId?: string;
  /** This browser's device file is in the old whole-file format: the next push rewrites it. */
  legacy?: boolean;
  /** The device file holds an older name than this browser's: the next push re-sends it. */
  renamed?: boolean;
  /** Number of this browser's newest change (change file or device file). */
  seq?: number;
  /** This browser's change files on Drive. */
  ops?: { id: string; seq: number }[];
  exportFileId?: string;
  exportHash?: string;
  /** `rev` of the data dulieu.txt was last brought up to date with. */
  publishedRev?: number;
  /** dulieu.txt's content and the backup files as of the last sync: a new version rewrites this state, which tells open Settings pages to refresh. */
  versionIds?: string;
  /** Other browsers' device file id -> the newest of their changes merged here (and the file's checksum, for old-format files). */
  merged?: Record<string, { seq: number; sum?: string }>;
  devices: RemoteDevice[];
  /** Origins that have a shadow for this account. */
  origins?: string[];
}

export interface SyncResult {
  /** localStorage keys written into the page. */
  written: string[];
  pushed: boolean;
  counts: ReturnType<typeof counts>;
  /** This browser's device, when another browser renamed it during this sync. */
  device?: Device;
}

export interface RemoteSummary {
  exists: boolean;
  devices: RemoteDevice[];
  exportUpdated?: string;
}

const tag = (k: string) => `appProperties has { key='stvSync' and value='${k}' }`;
const TAGGED = ["root", "device", "ops", "export"].map(tag).join(" or ");
/** What a sync lists: everything it reads, plus the backup files it may rotate. */
const SYNC_LIST = `${TAGGED} or ${tag("backup")}`;
/** What the versions are found from. */
const VERSIONS_LIST = `trashed=false and (${tag("root")} or ${tag("export")} or ${tag("backup")})`;

const kindOf = (f: DriveFile) => f.appProperties?.stvSync;
const deviceOf = (f: DriveFile) => f.appProperties?.device ?? "";
const seqOf = (f: DriveFile) => Number(f.appProperties?.seq ?? 0);
const oldestFirst = (a: DriveFile, b: DriveFile) => (a.createdTime ?? "").localeCompare(b.createdTime ?? "");
const toWire = (items: Items, keys: Iterable<string>): WireItems => {
  const out: WireItems = {};
  for (const k of keys) {
    const it = items[k];
    if (it) out[k] = [it.t, it.v];
  }
  return out;
};
const fromWire = (w: WireItems): Items => Object.fromEntries(Object.entries(w).map(([k, [t, v]]) => [k, { t, v }]));
const isNotFound = (e: unknown) => e instanceof DriveError && e.status === 404;


async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class SyncEngine {
  constructor(
    private readonly kv: KV,
    private readonly drive: Drive,
    readonly account: string,
    private device: Device,
    private readonly now: () => number = Date.now,
  ) {}

  private get stateKey() {
    return `state:${this.account}`;
  }
  private get remoteKey() {
    return `remote:${this.account}`;
  }
  /** Keys changed in this browser and not yet on Drive. Kept apart from the (large) state, so clearing it is cheap. */
  private get outboxKey() {
    return `outbox:${this.account}`;
  }
  private shadowKey(origin: string) {
    return `shadow:${this.account}:${origin}`;
  }

  private async load(): Promise<[AccountState, RemoteState]> {
    const state = (await this.kv.get<AccountState>(this.stateKey)) ?? { items: {}, rev: 0 };
    const remote = (await this.kv.get<RemoteState>(this.remoteKey)) ?? { devices: [] };
    return [state, remote];
  }

  async sync(replica?: Replica, times?: Record<string, number>): Promise<SyncResult> {
    const [state, remote] = await this.load();
    const name = this.device.name;
    const result = (written: string[]): SyncResult => ({
      written,
      pushed,
      counts: counts(state.items),
      device: this.device.name === name ? undefined : this.device,
    });
    let pushed = false;
    let joinSaved = false;
    let files: DriveFile[] = [];
    const pull = async () => {
      const r = await this.pull(state, remote);
      files = r.files;
      return r.changed;
    };
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const now = this.now();
      const read = replica ? await replica.read() : null;
      // No mark: the page's storage was cleared (site data, cookies) since the last sync. Treat it like a
      // first sync, so the empty page counts as nothing deleted and is filled back from Drive.
      const shadow = replica && read?.marked ? ((await this.kv.get<Snapshot>(this.shadowKey(replica.origin))) ?? null) : null;
      const touched = new Set<string>();
      let changed = false;
      // Joining (no shadow) merges against the account's data, so that is pulled first.
      if (attempt === 0 && !shadow) changed = (await pull()) || changed;
      if (read) changed = absorbLocal(state.items, read.snapshot, shadow, { now, times, stamp: read.stamp, touched }) || changed;
      if (attempt === 0 && shadow) changed = (await pull()) || changed;
      if (changed) changed = resolveTerms(state.items, touched) || changed;
      if (read && !shadow && !joinSaved) joinSaved = await this.saveJoin(read.snapshot, state.items, remote);
      changed = dropTombstones(state.items, now - TOMBSTONE_TTL) || changed;
      if (changed) {
        state.rev++;
        await this.kv.set(this.stateKey, state);
      }
      if (touched.size) await this.kv.set(this.outboxKey, [...new Set([...(await this.outbox()), ...touched])]);
      pushed = (await this.push(state, remote)) || pushed;
      await this.kv.set(this.remoteKey, remote);
      if (!replica || !read) {
        await this.publish(state, remote, files);
        return result([]);
      }

      const plan = planWrites(read.snapshot, buildSnapshot(state.items, read.snapshot));
      if ((!isEmptyPlan(plan) || !read.marked) && !(await replica.apply(plan))) continue;
      await this.kv.set(this.shadowKey(replica.origin), applyPlan(read.snapshot, plan));
      if (!remote.origins?.includes(replica.origin)) {
        remote.origins = [...(remote.origins ?? []), replica.origin];
        await this.kv.set(this.remoteKey, remote);
      }
      await this.publish(state, remote, files);
      return result(Object.keys(plan.set));
    }
    throw new Error("The page kept changing its data during sync; will retry.");
  }

  private async outbox(): Promise<string[]> {
    return (await this.kv.get<string[]>(this.outboxKey)) ?? [];
  }

  /** Merges other browsers' changes; `changed` if anything new arrived. */
  private async pull(state: AccountState, remote: RemoteState): Promise<{ changed: boolean; files: DriveFile[] }> {
    const files = await this.drive.list(`trashed=false and (${SYNC_LIST})`);
    files.sort(oldestFirst);
    remote.folderId ??= files.find((f) => kindOf(f) === "root")?.id;
    remote.exportFileId ??= files.find((f) => kindOf(f) === "export")?.id;
    const bases = files.filter((f) => kindOf(f) === "device");
    const changes = files.filter((f) => kindOf(f) === "ops").sort((a, b) => seqOf(a) - seqOf(b));

    // Gone from the listing: check the file itself, since a just-created file can lag behind in search.
    if (remote.deviceFileId && !bases.some((f) => f.id === remote.deviceFileId) && (await this.removed(remote.deviceFileId)))
      throw new DeviceRemovedError("This browser was removed from the account in another browser.");
    const own = bases.find((f) => deviceOf(f) === this.device.id && (!remote.deviceFileId || f.id === remote.deviceFileId));
    if (own) {
      remote.deviceFileId ??= own.id;
      remote.legacy = own.appProperties?.upTo === undefined;
      this.adoptName(own, remote);
    }
    // Numbering carries on from what Drive holds, also after this browser forgot its sync state.
    const mine = changes.filter((f) => deviceOf(f) === this.device.id).map((f) => ({ id: f.id, seq: seqOf(f) }));
    const top = Math.max(0, ...mine.map((o) => o.seq));
    // Keep the ones written after the newest listed: they may not be searchable yet.
    remote.ops = [...mine, ...(remote.ops ?? []).filter((o) => o.seq > top)];
    remote.seq = Math.max(remote.seq ?? 0, Number(own?.appProperties?.upTo ?? 0), top);

    let changed = false;
    const merge = (items: WireItems | undefined) => {
      if (items) changed = mergeItems(state.items, fromWire(items)) || changed;
    };
    const merged: NonNullable<RemoteState["merged"]> = {};
    for (const f of bases) {
      if (f.id === remote.deviceFileId) continue;
      const prev = remote.merged?.[f.id];
      if (f.appProperties?.upTo === undefined) {
        // An older version of this extension: the whole data, rewritten on every change.
        const sum = f.md5Checksum ?? f.modifiedTime ?? "";
        if (!sum || prev?.sum !== sum) merge((await this.downloadJson<DeviceFile>(f.id, "stv-drive-sync/device"))?.items);
        merged[f.id] = { seq: 0, sum };
        continue;
      }
      const upTo = Number(f.appProperties.upTo);
      const theirs = changes.filter((c) => deviceOf(c) === deviceOf(f));
      // The change files numbered right after `from`, without gaps (a new one may not be listed yet).
      const run = (from: number) => {
        const out: DriveFile[] = [];
        for (const c of theirs) {
          if (seqOf(c) <= from) continue;
          if (seqOf(c) > (out.length ? seqOf(out.at(-1)!) : from) + 1) break;
          out.push(c);
        }
        return out;
      };
      let from = prev?.seq ?? -1;
      let next = run(from);
      if (upTo > (next.length ? seqOf(next.at(-1)!) : from)) {
        // Further behind than the change files reach: start from the device file.
        merge((await this.downloadJson<DeviceFile>(f.id, "stv-drive-sync/device"))?.items);
        from = upTo;
        next = run(from);
      }
      const got = await Promise.all(next.map((c) => this.downloadJson<OpsFile>(c.id, "stv-drive-sync/ops")));
      for (const [i, file] of got.entries()) {
        if (file === null) break; // deleted meanwhile (folded into the device file): read that next time
        merge(file?.items);
        from = seqOf(next[i]!);
      }
      merged[f.id] = { seq: from };
    }
    remote.merged = merged;
    remote.devices = this.devicesFrom(files);
    remote.versionIds = files
      .filter((f) => kindOf(f) === "backup" || kindOf(f) === "export")
      .map((f) => (kindOf(f) === "export" ? `${f.id}@${f.modifiedTime}` : f.id))
      .sort()
      .join(",");
    return { changed, files };
  }

  /** The file's JSON if it has the expected format (undefined otherwise); null once it is deleted. */
  private async downloadJson<T extends { format: string }>(id: string, format: T["format"]): Promise<T | undefined | null> {
    try {
      const file = JSON.parse(await this.drive.download(id)) as Partial<T>;
      return file.format === format ? (file as T) : undefined;
    } catch (e) {
      if (isNotFound(e)) return null;
      if (e instanceof SyntaxError) return undefined;
      throw e;
    }
  }

  private async removed(fileId: string): Promise<boolean> {
    try {
      return !!(await this.drive.get(fileId)).trashed;
    } catch (e) {
      if (isNotFound(e)) return true;
      throw e;
    }
  }

  /** Takes a newer name given to this browser elsewhere; re-sends ours when Drive holds an older one. */
  private adoptName(f: DriveFile, remote: RemoteState): void {
    const name = f.appProperties?.deviceName;
    const at = Number(f.appProperties?.deviceNameAt ?? 0);
    if (name && at > (this.device.nameAt ?? 0)) this.device = { ...this.device, name, nameAt: at };
    else if (name !== this.device.name.slice(0, 60)) remote.renamed = true;
  }

  private devicesFrom(files: DriveFile[]): RemoteDevice[] {
    // A browser last synced when it last wrote its device file or a change file.
    const last = new Map<string, string>();
    for (const f of files) {
      const kind = kindOf(f);
      if (kind !== "device" && kind !== "ops") continue;
      const t = f.modifiedTime ?? "";
      if (t > (last.get(deviceOf(f)) ?? "")) last.set(deviceOf(f), t);
    }
    return files
      .filter((f) => kindOf(f) === "device")
      .map((f) => {
        const id = deviceOf(f);
        const self = id === this.device.id;
        return { id, name: self ? this.device.name : (f.appProperties?.deviceName ?? id), updated: last.get(id) || f.modifiedTime, self };
      });
  }

  /**
   * Uploads what changed here: a change file, or the whole device file when there is
   * none yet, it is in the old format, the change is large, or enough change files piled up.
   */
  private async push(state: AccountState, remote: RemoteState, whole = false): Promise<boolean> {
    const outbox = await this.outbox();
    whole ||= !remote.deviceFileId || !!remote.legacy || outbox.length > OPS_MAX_ITEMS || (remote.ops?.length ?? 0) >= COMPACT_AT;
    if (!whole && !outbox.length) {
      if (remote.renamed && remote.deviceFileId) {
        await this.drive.patch(remote.deviceFileId, { appProperties: this.nameProps(this.device.name, this.device.nameAt ?? 0) });
        remote.renamed = false;
      }
      return false;
    }
    const folder = await this.ensureFolder(remote);
    const seq = (remote.seq ?? 0) + 1;
    if (whole) {
      const file: DeviceFile = {
        format: "stv-drive-sync/device",
        v: 1,
        device: this.device,
        updated: this.now(),
        upTo: seq,
        items: toWire(state.items, Object.keys(state.items)),
      };
      remote.deviceFileId = await this.upsert(remote.deviceFileId, JSON.stringify(file), "application/json", {
        name: `device-${this.device.id}.json`,
        parents: [folder],
        appProperties: { stvSync: "device", device: this.device.id, upTo: String(seq), ...this.nameProps(this.device.name, this.device.nameAt ?? 0) },
      });
      remote.legacy = remote.renamed = false;
      // Folded in: the change files go. Another browser still reading one falls back to the device file.
      const folded = remote.ops ?? [];
      remote.ops = [];
      await Promise.all(folded.map((o) => this.removeIfThere(o.id).catch((e) => console.warn("Could not delete a change file.", e))));
    } else {
      const file: OpsFile = { format: "stv-drive-sync/ops", v: 1, device: this.device.id, seq, items: toWire(state.items, outbox) };
      const created = await this.drive.create(
        { name: `changes-${this.device.id}-${seq}.json`, parents: [folder], appProperties: { stvSync: "ops", device: this.device.id, seq: String(seq) } },
        JSON.stringify(file),
        "application/json",
      );
      remote.ops = [...(remote.ops ?? []), { id: created.id, seq }];
    }
    remote.seq = seq;
    await this.kv.set(this.outboxKey, []);
    const self: RemoteDevice = { id: this.device.id, name: this.device.name, updated: new Date(this.now()).toISOString(), self: true };
    remote.devices = [...remote.devices.filter((d) => !d.self), self];
    return true;
  }

  private async upsert(
    id: string | undefined,
    content: string,
    type: string,
    meta: FileMeta & { parents: string[]; appProperties: Record<string, string> },
    opts?: UploadOptions,
  ): Promise<string> {
    if (id) {
      try {
        const { name: _n, ...rest } = meta;
        return (await this.drive.update(id, content, type, rest, opts)).id;
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    }
    return (await this.drive.create(meta, content, type, opts)).id;
  }

  private async ensureFolder(remote: RemoteState): Promise<string> {
    if (remote.folderId) return remote.folderId;
    const existing = await this.drive.byKind("root");
    remote.folderId = existing[0]?.id ?? (await this.drive.createFolder({ name: FOLDER_NAME, appProperties: { stvSync: "root" } })).id;
    return remote.folderId;
  }

  private nameProps(name: string, at: number): Record<string, string> {
    return { deviceName: name.slice(0, 60), deviceNameAt: String(at) };
  }

  /**
   * Brings dulieu.txt up to date with the merged data, after the page already has it.
   * Each upload is kept as a revision of dulieu.txt: those are the versions, so the
   * data goes up once. Skipped when another browser already did it; a failure is retried
   * by the next sync and never fails this one.
   */
  private async publish(state: AccountState, remote: RemoteState, files: DriveFile[]): Promise<void> {
    if (remote.publishedRev === state.rev && remote.exportHash) return;
    const c = counts(state.items);
    if (!c.books && !c.names) return;
    try {
      if (await this.writeExport(state, remote, files)) {
        const root = files.filter((f) => kindOf(f) === "root").sort(oldestFirst)[0];
        await this.rotate(files, remote, policyFrom(root?.appProperties));
      }
      remote.publishedRev = state.rev;
    } catch (e) {
      console.warn("Could not update dulieu.txt or its versions; the next sync tries again.", e);
    }
    await this.kv.set(this.remoteKey, remote);
  }

  /** Uploads the data to dulieu.txt as a new version, unless the listed dulieu.txt already holds it. True when uploaded. */
  private async writeExport(state: AccountState, remote: RemoteState, files: DriveFile[]): Promise<boolean> {
    const text = exportText(state.items);
    const hash = await sha256(text);
    const exp = files.find((f) => kindOf(f) === "export" && f.id === remote.exportFileId);
    const uploaded = exp?.appProperties?.hash !== hash;
    if (uploaded) {
      const c = counts(state.items);
      remote.exportFileId = await this.upsert(
        remote.exportFileId,
        text,
        "text/plain",
        {
          name: EXPORT_NAME,
          parents: [await this.ensureFolder(remote)],
          appProperties: { stvSync: "export", hash },
          originalFilename: revisionName(this.device.name.slice(0, 60), c.books, c.names),
        },
        { keepForever: true },
      );
    }
    remote.exportHash = hash;
    return uploaded;
  }
  /** What Drive holds for this account, without changing anything. */
  async summary(): Promise<RemoteSummary> {
    const files = await this.drive.list(`trashed=false and (${TAGGED})`);
    const devices = this.devicesFrom(files);
    const exp = files.find((f) => kindOf(f) === "export");
    return { exists: devices.length > 0 || !!exp, devices, exportUpdated: exp?.modifiedTime };
  }

  /** A browser's device file and change files. */
  private deviceFiles(id: string, kinds = ["device", "ops"]): Promise<DriveFile[]> {
    return this.drive.list(`trashed=false and (${kinds.map(tag).join(" or ")}) and appProperties has { key='device' and value=${quote(id)} }`);
  }

  /** Lists the account's browsers from Drive and refreshes the cached list (once this account has synced here). */
  async listDevices(): Promise<RemoteDevice[]> {
    const devices = this.devicesFrom(await this.drive.list(`trashed=false and (${tag("device")} or ${tag("ops")})`));
    await this.updateCache((remote) => (remote.devices = devices));
    return devices;
  }

  /** Renames a browser on Drive; that browser takes the name at its next sync. */
  async renameDevice(id: string, name: string, at: number): Promise<void> {
    if (id === this.device.id) this.device = { ...this.device, name, nameAt: at };
    for (const f of await this.deviceFiles(id, ["device"])) await this.drive.patch(f.id, { appProperties: this.nameProps(name, at) });
    await this.updateCache((remote) => (remote.devices = remote.devices.map((d) => (d.id === id ? { ...d, name } : d))));
  }

  /**
   * Moves a browser's files to the Drive trash. Its changes already merged stay; that
   * browser stops syncing with this account at its next sync. Removing this browser also
   * forgets its sync state here, like a fresh install.
   */
  async removeDevice(id: string): Promise<void> {
    await Promise.all((await this.deviceFiles(id)).map((f) => this.drive.patch(f.id, { trashed: true })));
    if (id === this.device.id) return this.forget();
    await this.updateCache((remote) => (remote.devices = remote.devices.filter((d) => d.id !== id)));
  }

  private async updateCache(fn: (remote: RemoteState) => void): Promise<void> {
    const remote = await this.kv.get<RemoteState>(this.remoteKey);
    if (!remote) return;
    fn(remote);
    await this.kv.set(this.remoteKey, remote);
  }

  // ---- versions

  /** The policy and every version, newest first. */
  async versions(): Promise<{ policy: VersionPolicy; versions: Version[] }> {
    const files = (await this.drive.list(VERSIONS_LIST)).sort(oldestFirst);
    const root = files.find((f) => kindOf(f) === "root");
    const exp = files.find((f) => kindOf(f) === "export");
    return { policy: policyFrom(root?.appProperties), versions: await this.versionList(files, exp?.id) };
  }

  /** The version files in `files` (stvSync = backup), and all of dulieu.txt's revisions, as Drive's "Manage versions" lists them. */
  private async versionList(files: DriveFile[], exportId: string | undefined): Promise<Version[]> {
    const out = files.filter((f) => kindOf(f) === "backup").map(versionFrom);
    if (exportId) {
      try {
        const revisions = await this.drive.revisions(exportId);
        const head = revisions.at(-1)?.id;
        out.push(...revisions.map((r) => versionFromRevision(exportId, r, r.id === head)));
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    }
    return out.sort(byNewest);
  }

  private async joinFileMeta(items: Items, remote: RemoteState, reason: VersionReason): Promise<FileMeta> {
    const at = this.now();
    const c = counts(items);
    const day = dayOf(at);
    return {
      name: `dulieu before joining - ${this.device.name.slice(0, 60)} - ${day} ${new Date(at).toTimeString().slice(0, 8).replaceAll(":", "")}.txt`,
      parents: [await this.ensureFolder(remote)],
      appProperties: {
        stvSync: "backup",
        at: String(at),
        day,
        deviceName: this.device.name.slice(0, 60),
        books: String(c.books),
        names: String(c.names),
        reason,
      },
    };
  }

  /**
   * When a joining page loses something to the account's data (a lower chapter, a name
   * translated differently), saves the page's own data as a version first. True when done
   * or not needed; a failure leaves it to the next attempt and never fails the sync.
   */
  private async saveJoin(page: Snapshot, items: Items, remote: RemoteState): Promise<boolean> {
    const own = liveItems(page).values;
    if (![...own].some(([k, v]) => items[k]?.v !== v)) return true;
    try {
      const pageItems: Items = Object.fromEntries([...own].map(([k, v]) => [k, { t: 0, v }]));
      await this.drive.create(await this.joinFileMeta(pageItems, remote, "join"), JSON.stringify(toExport(page)), "text/plain");
      return true;
    } catch (e) {
      console.warn("Could not save this browser's data before joining.", e);
      return false;
    }
  }

  /**
   * After a new version: makes sure it is kept forever (Drive may not have honoured the
   * upload's flag, or another browser on an older release uploaded it), then applies the policy.
   */
  private async rotate(files: DriveFile[], remote: RemoteState, policy: VersionPolicy, keep?: string): Promise<void> {
    const versions = await this.versionList(files, remote.exportFileId);
    const head = versions.find((v) => v.current && v.temporary);
    const rev = head && parseRevisionId(head.id);
    if (rev) {
      await this.drive.keepRevision(rev.fileId, rev.revId, true);
      head.temporary = false;
    }
    await this.prune(versions, policy, keep);
  }

  private async prune(versions: Version[], policy: VersionPolicy, keep?: string): Promise<void> {
    const gone = toPrune(versions, policy).filter((v) => v.id !== keep && !v.current);
    // Another browser may have pruned the same version already.
    await Promise.all(gone.map((v) => this.removeVersion(v.id).catch((e) => (isNotFound(e) ? undefined : Promise.reject(e)))));
  }

  private removeVersion(id: string): Promise<void> {
    const rev = parseRevisionId(id);
    return rev ? this.drive.removeRevision(rev.fileId, rev.revId) : this.drive.remove(id);
  }

  private async removeIfThere(id: string): Promise<void> {
    try {
      await this.drive.remove(id);
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }

  /** The files a version action needs; the remote state learns dulieu.txt's id from them. */
  private async versionFiles(remote: RemoteState): Promise<{ files: DriveFile[]; policy: VersionPolicy }> {
    const files = (await this.drive.list(VERSIONS_LIST)).sort(oldestFirst);
    remote.exportFileId ??= files.find((f) => kindOf(f) === "export")?.id;
    return { files, policy: policyFrom(files.find((f) => kindOf(f) === "root")?.appProperties) };
  }

  /** Saves the current data as a version now; skipped when dulieu.txt already holds it. */
  async saveVersion(): Promise<void> {
    const [state, remote] = await this.load();
    const { files, policy } = await this.versionFiles(remote);
    if (await this.writeExport(state, remote, files)) await this.rotate(files, remote, policy);
    await this.updateCache((r) => Object.assign(r, { exportHash: remote.exportHash, exportFileId: remote.exportFileId, folderId: remote.folderId }));
  }

  async setVersionPolicy(p: Partial<VersionPolicy>): Promise<VersionPolicy> {
    const policy = clampPolicy(p);
    const [, remote] = await this.load();
    const folder = await this.ensureFolder(remote);
    await this.drive.patch(folder, { appProperties: policyProps(policy) });
    await this.updateCache((r) => (r.folderId = folder));
    await this.prune((await this.versions()).versions, policy);
    return policy;
  }

  /** Deletes a version; the latest one (dulieu.txt's current content) never. */
  async deleteVersion(id: string): Promise<void> {
    const rev = parseRevisionId(id);
    if (rev && (await this.drive.revisions(rev.fileId)).at(-1)?.id === rev.revId)
      throw new Error("The latest version is dulieu.txt's current content; it can't be deleted.");
    try {
      await this.removeVersion(id);
    } catch (e) {
      // Drive may only delete revisions kept forever.
      if (!rev || !(e instanceof DriveError) || e.status === 404) throw e;
      await this.drive.keepRevision(rev.fileId, rev.revId, true);
      await this.removeVersion(id);
    }
  }

  async downloadVersion(id: string): Promise<string> {
    const rev = parseRevisionId(id);
    if (!rev) return this.drive.download(id);
    try {
      return await this.drive.downloadRevision(rev.fileId, rev.revId);
    } catch (e) {
      // Drive only hands out revisions kept forever: keep a temporary one for the download, then let it go again.
      if (!(e instanceof DriveError) || e.status === 404) throw e;
      await this.drive.keepRevision(rev.fileId, rev.revId, true);
      try {
        return await this.drive.downloadRevision(rev.fileId, rev.revId);
      } finally {
        await this.drive.keepRevision(rev.fileId, rev.revId, false).catch(() => undefined);
      }
    }
  }

  /**
   * Replaces the account's data with a version, in every browser (as a change
   * newer than everything). The current data is saved as a version first.
   * Open pages get it at their next sync.
   */
  async restoreVersion(id: string): Promise<void> {
    const file = JSON.parse(await this.downloadVersion(id)) as Partial<ExportFile>;
    if (!file || typeof file !== "object" || typeof file.name !== "object") throw new Error("That file is not a version of the data.");
    const [state, remote] = await this.load();
    const { files, policy } = await this.versionFiles(remote);
    await this.writeExport(state, remote, files); // the data being replaced stays as a version
    replaceWith(state.items, fromExport({ name: file.name, tusach: file.tusach }), this.now());
    resolveTerms(state.items);
    state.rev++;
    await this.kv.set(this.stateKey, state);
    await this.push(state, remote, true);
    await this.writeExport(state, remote, []);
    remote.publishedRev = state.rev;
    await this.kv.set(this.remoteKey, remote);
    await this.rotate(files, remote, policy, id); // never the version just restored
  }
  async exportText(): Promise<string> {
    const [state] = await this.load();
    return exportText(state.items);
  }

  async stats(): Promise<ReturnType<typeof counts>> {
    const [state] = await this.load();
    return counts(state.items);
  }

  /** Forgets everything synced for this account on this browser (Drive is untouched). */
  async forget(): Promise<void> {
    const [, remote] = await this.load();
    for (const o of remote.origins ?? []) await this.kv.remove(this.shadowKey(o));
    await this.kv.remove(this.stateKey);
    await this.kv.remove(this.remoteKey);
    await this.kv.remove(this.outboxKey);
  }
}

export function exportText(items: Items): string {
  return JSON.stringify(toExport(buildSnapshot(items, EMPTY)));
}
