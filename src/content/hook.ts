/**
 * Page (MAIN) world, document_start. SangTacViet keeps personal data only in
 * localStorage and has no API for it, so this wraps Storage.prototype to
 * report every localStorage write the site makes (updateTusach, saveNS,
 * removebookfromts, importTusach, ...) to the content script.
 *
 * After a sync writes new data, it also brings the page's in-memory copies up
 * to date — the chapter page's name editor would otherwise save its stale list
 * over the synced names on the next "Lưu lại"/name add.
 */
import { PAGE_TAG } from "../shared/messages";

interface StvWindow {
  __stvDriveSyncHook?: boolean;
  hmeta?: Record<string, unknown>;
  namew?: HTMLTextAreaElement | null;
  setting?: { onlyonename?: boolean } | null;
  reloadBook?: () => void;
}

(() => {
  const w = window as unknown as StvWindow;
  if (w.__stvDriveSyncHook) return;
  w.__stvDriveSyncHook = true;

  const post = (data: Record<string, unknown>) => window.postMessage({ [PAGE_TAG]: true, ...data }, location.origin);
  const proto = Storage.prototype;
  const { setItem, removeItem, clear } = proto;
  const touched = (store: Storage, key: string) => {
    try {
      if (store === window.localStorage) post({ kind: "dirty", key, t: Date.now() });
    } catch {}
  };
  proto.setItem = function (this: Storage, key: string, value: string) {
    setItem.call(this, key, value);
    touched(this, String(key));
  };
  proto.removeItem = function (this: Storage, key: string) {
    removeItem.call(this, key);
    touched(this, String(key));
  };
  proto.clear = function (this: Storage) {
    clear.call(this);
    touched(this, "*");
  };

  // Name-key prefixes come from stv.host.js (window.hmeta); new sources show up there first.
  const sendHosts = () => {
    if (w.hmeta && typeof w.hmeta === "object") post({ kind: "hosts", hosts: Object.keys(w.hmeta) });
  };
  window.addEventListener("load", () => setTimeout(sendHosts, 1500));

  window.addEventListener("message", (e) => {
    const d = e.data as { [PAGE_TAG]?: boolean; kind?: string; keys?: string[] } | null;
    if (e.source !== window || !d?.[PAGE_TAG] || d.kind !== "applied" || !d.keys) return;
    const keys = d.keys;

    const hid = document.getElementById("hiddenid")?.textContent?.split(";");
    if (hid && hid.length >= 3) {
      const key = w.setting?.onlyonename ? "qtOnline0" : `${hid[2]}${hid[0]}`;
      const editor = w.namew ?? (document.getElementById("namewd") as HTMLTextAreaElement | null);
      if (keys.includes(key) && editor) editor.value = (localStorage.getItem(key) ?? "").split("~//~").join("\n");
    }
    const list = document.getElementById("tusach");
    if (keys.includes("tusach") && list && typeof w.reloadBook === "function") {
      list.innerHTML = "";
      w.reloadBook();
    }
  });
})();
