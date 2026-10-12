import type { Device, RemoteDevice, RemoteSummary } from "./engine";
import type { WritePlan, counts } from "./model";
import type { Snapshot } from "./sitedata";

/** window.postMessage tag between the MAIN-world hook and the content script. */
export const PAGE_TAG = "__stvDriveSync";

export type ContentToBackground =
  | { type: "hello" }
  | { type: "dirty"; key: string; t: number }
  | { type: "hosts"; hosts: string[] };

export type BackgroundToContent = { type: "read"; hosts: string[] } | { type: "apply"; plan: WritePlan };

export interface ReadReply {
  snapshot: Snapshot;
  stamp?: number;
  marked: boolean;
}

export interface ApplyReply {
  ok: boolean;
  error?: string;
}

export type UiRequest =
  | { type: "status" }
  | { type: "summary" }
  | { type: "addAccount" }
  | { type: "reconnect"; sub: string }
  | { type: "removeAccount"; sub: string }
  | { type: "setActive"; sub: string }
  | { type: "link" }
  | { type: "unlink" }
  | { type: "syncNow" }
  | { type: "export" }
  | { type: "devices" }
  | { type: "renameDevice"; id: string; name: string }
  | { type: "removeDevice"; id: string }
  | { type: "versions" }
  | { type: "saveVersion" }
  | { type: "deleteVersion"; id: string }
  | { type: "downloadVersion"; id: string }
  | { type: "restoreVersion"; id: string }
  | { type: "settingsChanged" };

export interface Account {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

export interface AccountView extends Account {
  needsAuth: boolean;
  linked: boolean;
}

export interface Status {
  clientId: boolean;
  redirectUri: string;
  device: Device;
  domains: string[];
  accounts: AccountView[];
  active?: string;
  syncing: boolean;
  lastSync?: number;
  /** Why sync stopped on its own, e.g. this browser was removed in another one. */
  notice?: string;
  lastError?: string;
  counts?: ReturnType<typeof counts>;
  devices: RemoteDevice[];
  openTabs: number;
}

export type Reply<T = unknown> = { ok: true; value: T } | { ok: false; error: string };
export type SummaryReply = Reply<RemoteSummary>;
