/**
 * One sync round for one Google account:
 *
 *   1. read the page's localStorage (a "replica": one sangtacviet origin open in a tab)
 *      and record what changed since its last sync
 *   2. merge every other browser's device file from Drive
 *   3. upload this browser's device file, and the site-format dulieu.txt, if anything changed
 *   4. write the merged result back into the page — only if the page did not change
 *      meanwhile (compare-and-set), otherwise start over
 *
 * Each browser writes only its own device file, so two browsers syncing at the
 * same moment cannot overwrite each other's changes on Drive.
 */
import { Drive, DriveError, type DriveFile, quote } from "./drive";
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
  planWrites,
  replaceWith,
} from "./model";
import { type ExportFile, type Snapshot, fromExport, toExport } from "./sitedata";
import {
  type BackupPolicy,
  type BackupReason,
  type BackupVersion,
  BACKUP_GAP,
  byNewest,
  clampPolicy,
  dayOf,
  policyFrom,
  policyProps,
  toPrune,
  versionFrom,
} from "./backups";

export const FOLDER_NAME = "SangTacViet Sync";
export const EXPORT_NAME = "dulieu.txt";
export const TOMBSTONE_TTL = 180 * 24 * 3600 * 1000;
const MAX_ATTEMPTS = 5;

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

export interface DeviceFile {
  format: "stv-drive-sync/device";
  v: 1;
  device: Device;
  updated: number;
  items: Record<string, [t: number, v: string | null]>;
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
  exportFileId?: string;
  pushedRev: number;
  exportHash?: string;
  /** Hash and time of the newest backup version this browser knows of. */
  backupHash?: string;
  backupAt?: number;
  /** Device file id -> checksum already merged. */
  peers: Record<string, string>;
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
const TAGGED = ["root", "device", "export"].map(tag).join(" or ");

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
  private shadowKey(origin: string) {
    return `shadow:${this.account}:${origin}`;
  }

  private async load(): Promise<[AccountState, RemoteState]> {
    const state = (await this.kv.get<AccountState>(this.stateKey)) ?? { items: {}, rev: 0 };
    const remote = (await this.kv.get<RemoteState>(this.remoteKey)) ?? { pushedRev: -1, peers: {}, devices: [] };
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
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const now = this.now();
      const read = replica ? await replica.read() : null;
      // No mark: the page's storage was cleared (site data, cookies) since the last sync. Treat it like a
      // first sync, so the empty page counts as nothing deleted and is filled back from Drive.
      const shadow = replica && read?.marked ? ((await this.kv.get<Snapshot>(this.shadowKey(replica.origin))) ?? null) : null;
      let changed = false;
      if (read) changed = absorbLocal(state.items, read.snapshot, shadow, { now, times, stamp: read.stamp }) || changed;
      if (attempt === 0) changed = (await this.pull(state, remote)) || changed;
      changed = dropTombstones(state.items, now - TOMBSTONE_TTL) || changed;
      if (changed) state.rev++;
      await this.kv.set(this.stateKey, state);
      pushed = (await this.push(state, remote)) || pushed;
      await this.kv.set(this.remoteKey, remote);
      if (attempt === 0 && (await this.autoBackup(state, remote))) await this.kv.set(this.remoteKey, remote);
      if (!replica || !read) return result([]);

      const plan = planWrites(read.snapshot, buildSnapshot(state.items, read.snapshot));
      if ((!isEmptyPlan(plan) || !read.marked) && !(await replica.apply(plan))) continue;
      await this.kv.set(this.shadowKey(replica.origin), applyPlan(read.snapshot, plan));
      if (!remote.origins?.includes(replica.origin)) {
        remote.origins = [...(remote.origins ?? []), replica.origin];
        await this.kv.set(this.remoteKey, remote);
      }
      return result(Object.keys(plan.set));
    }
    throw new Error("The page kept changing its data during sync; will retry.");
  }

  /** Merges other browsers' device files; true if anything new arrived. */
  private async pull(state: AccountState, remote: RemoteState): Promise<boolean> {
    const files = await this.drive.list(`trashed=false and (${TAGGED})`);
    files.sort((a, b) => (a.createdTime ?? "").localeCompare(b.createdTime ?? ""));
    const kind = (f: DriveFile) => f.appProperties?.stvSync;
    remote.folderId ??= files.find((f) => kind(f) === "root")?.id;
    remote.exportFileId ??= files.find((f) => kind(f) === "export")?.id;

    let changed = false;
    const seen: Record<string, string> = {};
    const mine = files.filter((f) => kind(f) === "device");
    // Gone from the listing: check the file itself, since a just-created file can lag behind in search.
    if (remote.deviceFileId && !mine.some((f) => f.id === remote.deviceFileId) && (await this.removed(remote.deviceFileId)))
      throw new DeviceRemovedError("This browser was removed from the account in another browser.");
    for (const f of mine) {
      const id = f.appProperties?.device ?? "";
      if (id === this.device.id) {
        remote.deviceFileId ??= f.id;
        if (f.id === remote.deviceFileId) {
          this.adoptName(f, remote);
          continue;
        }
      }
      const sum = f.md5Checksum ?? f.modifiedTime ?? "";
      seen[f.id] = sum;
      if (sum && remote.peers[f.id] === sum) continue;
      const file = JSON.parse(await this.drive.download(f.id)) as Partial<DeviceFile>;
      if (file.format !== "stv-drive-sync/device" || !file.items) continue;
      const items: Items = {};
      for (const [k, [t, v]] of Object.entries(file.items)) items[k] = { t, v };
      changed = mergeItems(state.items, items) || changed;
    }
    remote.peers = seen;
    remote.devices = this.devicesFrom(files);
    return changed;
  }

  private async removed(fileId: string): Promise<boolean> {
    try {
      return !!(await this.drive.get(fileId)).trashed;
    } catch (e) {
      if (e instanceof DriveError && e.status === 404) return true;
      throw e;
    }
  }

  /** Takes a newer name given to this browser elsewhere; re-uploads ours when Drive holds an older one. */
  private adoptName(f: DriveFile, remote: RemoteState): void {
    const name = f.appProperties?.deviceName;
    const at = Number(f.appProperties?.deviceNameAt ?? 0);
    if (name && at > (this.device.nameAt ?? 0)) this.device = { ...this.device, name, nameAt: at };
    else if (name !== this.device.name.slice(0, 60)) remote.pushedRev = -1;
  }

  private devicesFrom(files: DriveFile[]): RemoteDevice[] {
    return files
      .filter((f) => f.appProperties?.stvSync === "device")
      .map((f) => {
        const id = f.appProperties?.device ?? "";
        const self = id === this.device.id;
        return { id, name: self ? this.device.name : (f.appProperties?.deviceName ?? id), updated: f.modifiedTime, self };
      });
  }

  /** Uploads this browser's device file and dulieu.txt when they changed. */
  private async push(state: AccountState, remote: RemoteState): Promise<boolean> {
    if (state.rev === remote.pushedRev && remote.deviceFileId) return false;
    const folder = await this.ensureFolder(remote);
    const file: DeviceFile = {
      format: "stv-drive-sync/device",
      v: 1,
      device: this.device,
      updated: this.now(),
      items: Object.fromEntries(Object.entries(state.items).map(([k, it]) => [k, [it.t, it.v]])),
    };
    remote.deviceFileId = await this.upsert(remote.deviceFileId, JSON.stringify(file), "application/json", {
      name: `device-${this.device.id}.json`,
      parents: [folder],
      appProperties: { stvSync: "device", device: this.device.id, ...this.nameProps(this.device.name, this.device.nameAt ?? 0) },
    });
    remote.pushedRev = state.rev;
    const self: RemoteDevice = { id: this.device.id, name: this.device.name, updated: new Date(this.now()).toISOString(), self: true };
    remote.devices = [...remote.devices.filter((d) => !d.self), self];

    const text = exportText(state.items);
    const hash = await sha256(text);
    if (hash !== remote.exportHash) {
      remote.exportFileId = await this.upsert(remote.exportFileId, text, "text/plain", {
        name: EXPORT_NAME,
        parents: [folder],
        appProperties: { stvSync: "export" },
      });
      remote.exportHash = hash;
    }
    return true;
  }

  private async upsert(
    id: string | undefined,
    content: string,
    type: string,
    meta: { name: string; parents: string[]; appProperties: Record<string, string> },
  ): Promise<string> {
    if (id) {
      try {
        return (await this.drive.update(id, content, type, meta.appProperties)).id;
      } catch (e) {
        if (!(e instanceof DriveError && e.status === 404)) throw e;
      }
    }
    return (await this.drive.create(meta, content, type)).id;
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

  /** What Drive holds for this account, without changing anything. */
  async summary(): Promise<RemoteSummary> {
    const files = await this.drive.list(`trashed=false and (${TAGGED})`);
    const devices = this.devicesFrom(files);
    const exp = files.find((f) => f.appProperties?.stvSync === "export");
    return { exists: devices.length > 0 || !!exp, devices, exportUpdated: exp?.modifiedTime };
  }

  private deviceFiles(id: string): Promise<DriveFile[]> {
    return this.drive.list(`trashed=false and ${tag("device")} and appProperties has { key='device' and value=${quote(id)} }`);
  }

  /** Lists the account's browsers from Drive and refreshes the cached list (once this account has synced here). */
  async listDevices(): Promise<RemoteDevice[]> {
    const devices = this.devicesFrom(await this.drive.list(`trashed=false and ${tag("device")}`));
    await this.updateCache((remote) => (remote.devices = devices));
    return devices;
  }

  /** Renames a browser on Drive; that browser takes the name at its next sync. */
  async renameDevice(id: string, name: string, at: number): Promise<void> {
    if (id === this.device.id) this.device = { ...this.device, name, nameAt: at };
    for (const f of await this.deviceFiles(id)) await this.drive.patch(f.id, { appProperties: this.nameProps(name, at) });
    await this.updateCache((remote) => (remote.devices = remote.devices.map((d) => (d.id === id ? { ...d, name } : d))));
  }

  /**
   * Moves a browser's device file to the Drive trash. Its changes already merged stay; that
   * browser stops syncing with this account at its next sync. Removing this browser also
   * forgets its sync state here, like a fresh install.
   */
  async removeDevice(id: string): Promise<void> {
    for (const f of await this.deviceFiles(id)) await this.drive.patch(f.id, { trashed: true });
    if (id === this.device.id) return this.forget();
    await this.updateCache((remote) => (remote.devices = remote.devices.filter((d) => d.id !== id)));
  }

  private async updateCache(fn: (remote: RemoteState) => void): Promise<void> {
    const remote = await this.kv.get<RemoteState>(this.remoteKey);
    if (!remote) return;
    fn(remote);
    await this.kv.set(this.remoteKey, remote);
  }

  // ---- backup versions

  /** The policy and every version, newest first. */
  async backups(): Promise<{ policy: BackupPolicy; versions: BackupVersion[] }> {
    const files = await this.drive.list(`trashed=false and (${tag("root")} or ${tag("backup")})`);
    const root = files.filter((f) => f.appProperties?.stvSync === "root").sort((a, b) => (a.createdTime ?? "").localeCompare(b.createdTime ?? ""))[0];
    const versions = files.filter((f) => f.appProperties?.stvSync === "backup").map(versionFrom).sort(byNewest);
    return { policy: policyFrom(root?.appProperties), versions };
  }

  /** Saves a version after a sync when the data changed since the newest one, at most once per BACKUP_GAP. */
  private async autoBackup(state: AccountState, remote: RemoteState): Promise<boolean> {
    if (!counts(state.items).books && !counts(state.items).names) return false;
    const text = exportText(state.items);
    const hash = await sha256(text);
    const now = this.now();
    if (hash === remote.backupHash || now - (remote.backupAt ?? 0) < BACKUP_GAP) return false;
    try {
      const { policy, versions } = await this.backups();
      const newest = versions[0];
      if (newest && (newest.hash === hash || now - newest.at < BACKUP_GAP)) {
        remote.backupHash = newest.hash;
        remote.backupAt = newest.at;
        return true;
      }
      const v = await this.writeBackup(text, hash, state.items, remote, "auto");
      await this.prune([v, ...versions], policy);
    } catch (e) {
      console.warn("Backup failed; the next sync tries again.", e); // never fails the sync itself
    }
    return true;
  }

  private async writeBackup(text: string, hash: string, items: Items, remote: RemoteState, reason: BackupReason): Promise<BackupVersion> {
    const at = this.now();
    const c = counts(items);
    const day = dayOf(at);
    const file = await this.drive.create(
      {
        name: `backup ${day} ${new Date(at).toTimeString().slice(0, 8).replaceAll(":", "")}.txt`,
        parents: [await this.ensureFolder(remote)],
        appProperties: {
          stvSync: "backup",
          at: String(at),
          day,
          deviceName: this.device.name.slice(0, 60),
          books: String(c.books),
          names: String(c.names),
          hash,
          reason,
        },
      },
      text,
      "text/plain",
    );
    remote.backupHash = hash;
    remote.backupAt = at;
    return versionFrom(file);
  }

  private async prune(versions: BackupVersion[], policy: BackupPolicy, keep?: string): Promise<void> {
    for (const v of toPrune(versions, policy, this.now())) if (v.id !== keep) await this.drive.remove(v.id);
  }

  /** Saves a version now, whatever the gap; skipped when the newest one already holds the same data. */
  async backupNow(): Promise<void> {
    const [state, remote] = await this.load();
    const text = exportText(state.items);
    const hash = await sha256(text);
    const { policy, versions } = await this.backups();
    if (versions[0]?.hash === hash) return;
    const v = await this.writeBackup(text, hash, state.items, remote, "manual");
    await this.prune([v, ...versions], policy);
    await this.updateCache((r) => Object.assign(r, { backupHash: remote.backupHash, backupAt: remote.backupAt, folderId: remote.folderId }));
  }

  async setBackupPolicy(p: Partial<BackupPolicy>): Promise<BackupPolicy> {
    const policy = clampPolicy(p);
    const [, remote] = await this.load();
    const folder = await this.ensureFolder(remote);
    await this.drive.patch(folder, { appProperties: policyProps(policy) });
    await this.updateCache((r) => (r.folderId = folder));
    await this.prune((await this.backups()).versions, policy);
    return policy;
  }

  async deleteBackup(id: string): Promise<void> {
    await this.drive.remove(id);
  }

  async downloadBackup(id: string): Promise<string> {
    return this.drive.download(id);
  }

  /**
   * Replaces the account's data with a version, in every browser (as a change
   * newer than everything). The current data is saved as a version first.
   * Open pages get it at their next sync.
   */
  async restoreBackup(id: string): Promise<void> {
    const file = JSON.parse(await this.drive.download(id)) as Partial<ExportFile>;
    if (!file || typeof file !== "object" || typeof file.name !== "object") throw new Error("That file is not a backup version.");
    const [state, remote] = await this.load();
    const { policy, versions } = await this.backups();
    const text = exportText(state.items);
    const hash = await sha256(text);
    const saved = versions[0]?.hash === hash ? [] : [await this.writeBackup(text, hash, state.items, remote, "restore")];
    replaceWith(state.items, fromExport({ name: file.name, tusach: file.tusach }), this.now());
    state.rev++;
    await this.kv.set(this.stateKey, state);
    await this.push(state, remote);
    await this.kv.set(this.remoteKey, remote);
    await this.prune([...saved, ...versions], policy, id); // never the version just restored
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
  }
}

export function exportText(items: Items): string {
  return JSON.stringify(toExport(buildSnapshot(items, EMPTY)));
}
