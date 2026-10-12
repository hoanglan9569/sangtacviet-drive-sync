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
import { Drive, DriveError, type DriveFile } from "./drive";
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
} from "./model";
import { type Snapshot, toExport } from "./sitedata";

export const FOLDER_NAME = "SangTacViet Sync";
export const EXPORT_NAME = "dulieu.txt";
export const TOMBSTONE_TTL = 180 * 24 * 3600 * 1000;
const MAX_ATTEMPTS = 5;

export interface Replica {
  origin: string;
  read(): Promise<{ snapshot: Snapshot; stamp?: number }>;
  /** Writes `plan.set` if every key still holds its `plan.expect` value; false when the page changed meanwhile. */
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
}

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
}

export interface RemoteSummary {
  exists: boolean;
  devices: RemoteDevice[];
  exportUpdated?: string;
}

const TAGGED = ["root", "device", "export"]
  .map((k) => `appProperties has { key='stvSync' and value='${k}' }`)
  .join(" or ");

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class SyncEngine {
  constructor(
    private readonly kv: KV,
    private readonly drive: Drive,
    readonly account: string,
    private readonly device: Device,
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
    let pushed = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const now = this.now();
      const read = replica ? await replica.read() : null;
      const shadow = replica ? ((await this.kv.get<Snapshot>(this.shadowKey(replica.origin))) ?? null) : null;
      let changed = false;
      if (read) changed = absorbLocal(state.items, read.snapshot, shadow, { now, times, stamp: read.stamp }) || changed;
      if (attempt === 0) changed = (await this.pull(state, remote)) || changed;
      changed = dropTombstones(state.items, now - TOMBSTONE_TTL) || changed;
      if (changed) state.rev++;
      await this.kv.set(this.stateKey, state);
      pushed = (await this.push(state, remote)) || pushed;
      await this.kv.set(this.remoteKey, remote);
      if (!replica || !read) return { written: [], pushed, counts: counts(state.items) };

      const plan = planWrites(read.snapshot, buildSnapshot(state.items, read.snapshot));
      if (!isEmptyPlan(plan) && !(await replica.apply(plan))) continue;
      await this.kv.set(this.shadowKey(replica.origin), applyPlan(read.snapshot, plan));
      if (!remote.origins?.includes(replica.origin)) {
        remote.origins = [...(remote.origins ?? []), replica.origin];
        await this.kv.set(this.remoteKey, remote);
      }
      return { written: Object.keys(plan.set), pushed, counts: counts(state.items) };
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
    const devices: RemoteDevice[] = [];
    for (const f of files.filter((f) => kind(f) === "device")) {
      const id = f.appProperties?.device ?? "";
      const self = id === this.device.id;
      devices.push({ id, name: f.appProperties?.deviceName ?? id, updated: f.modifiedTime, self });
      if (self) {
        remote.deviceFileId ??= f.id;
        if (f.id === remote.deviceFileId) continue;
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
    remote.devices = devices;
    return changed;
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
      appProperties: { stvSync: "device", device: this.device.id, deviceName: this.device.name.slice(0, 60) },
    });
    remote.pushedRev = state.rev;

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

  /** What Drive holds for this account, without changing anything. */
  async summary(): Promise<RemoteSummary> {
    const files = await this.drive.list(`trashed=false and (${TAGGED})`);
    const devices = files
      .filter((f) => f.appProperties?.stvSync === "device")
      .map((f) => {
        const id = f.appProperties?.device ?? "";
        return { id, name: f.appProperties?.deviceName ?? id, updated: f.modifiedTime, self: id === this.device.id };
      });
    const exp = files.find((f) => f.appProperties?.stvSync === "export");
    return { exists: devices.length > 0 || !!exp, devices, exportUpdated: exp?.modifiedTime };
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
