/**
 * Content script (isolated world), document_start. Relays the hook's write
 * notices to the background, and reads/writes the page's localStorage for it.
 * Writes are compare-and-set: they only happen if every key still holds the
 * value the sync started from, so a page write in between is never lost.
 */
import type { WritePlan } from "../shared/model";
import { type ApplyReply, type BackgroundToContent, type ContentToBackground, PAGE_TAG, type ReadReply } from "../shared/messages";
import { TUSACH_KEY, nameKeyMatcher } from "../shared/sitedata";

interface BridgeWindow {
  __stvDriveSyncBridge?: () => boolean;
}

(() => {
  const w = window as unknown as BridgeWindow;
  if (w.__stvDriveSyncBridge?.()) return;
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  w.__stvDriveSyncBridge = alive;

  const send = (msg: ContentToBackground) => {
    if (!alive()) return;
    chrome.runtime.sendMessage(msg).catch(() => {});
  };
  let hosts: string[] = [];
  let isName = nameKeyMatcher(hosts);

  window.addEventListener("message", (e) => {
    const d = e.data as { [PAGE_TAG]?: boolean; kind?: string; key?: string; t?: number; hosts?: string[] } | null;
    if (e.source !== window || !d?.[PAGE_TAG]) return;
    if (d.kind === "dirty" && typeof d.key === "string") {
      if (d.key === "*" || d.key === TUSACH_KEY || isName(d.key)) send({ type: "dirty", key: d.key, t: Number(d.t) || Date.now() });
    } else if (d.kind === "hosts" && Array.isArray(d.hosts)) {
      hosts = d.hosts.filter((h): h is string => typeof h === "string");
      isName = nameKeyMatcher(hosts);
      send({ type: "hosts", hosts });
    }
  });

  chrome.runtime.onMessage.addListener((msg: BackgroundToContent, _sender, reply) => {
    if (msg.type === "read") reply(read(msg.hosts));
    else if (msg.type === "apply") reply(apply(msg.plan));
    return false;
  });

  function read(extraHosts: string[]): ReadReply {
    const match = nameKeyMatcher([...hosts, ...extraHosts]);
    const names: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== null && match(k)) names[k] = localStorage.getItem(k) ?? "";
    }
    const stamp = /(?:^|;\s*)hstamp=(\d+)/.exec(document.cookie)?.[1];
    return { snapshot: { tusach: localStorage.getItem(TUSACH_KEY), names }, stamp: stamp ? Number(stamp) * 1000 : undefined };
  }

  function apply(plan: WritePlan): ApplyReply {
    for (const [k, v] of Object.entries(plan.expect)) if (localStorage.getItem(k) !== v) return { ok: false };
    const keys = Object.keys(plan.set);
    try {
      for (const k of keys) {
        const v = plan.set[k];
        if (v == null) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (keys.length) {
      window.postMessage({ [PAGE_TAG]: true, kind: "applied", keys }, location.origin);
      toast();
    }
    return { ok: true };
  }

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function toast(): void {
    const id = "stv-drive-sync-toast";
    document.getElementById(id)?.remove();
    const host = document.createElement("div");
    host.id = id;
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      div{font:13px/1.4 system-ui,sans-serif;background:#202124;color:#fff;padding:10px 12px;border-radius:8px;
        box-shadow:0 4px 16px rgba(0,0,0,.3);display:flex;gap:12px;align-items:center;max-width:320px}
      button{font:inherit;background:none;border:0;color:#8ab4f8;cursor:pointer;padding:0}
    </style><div><span>Reading history / names updated from Google Drive.</span><button>Reload</button></div>`;
    root.querySelector("button")!.addEventListener("click", () => location.reload());
    (document.body ?? document.documentElement).append(host);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => host.remove(), 8000);
  }

  send({ type: "hello" });
})();
