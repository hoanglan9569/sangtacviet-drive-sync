import { domainPatterns, getSettings } from "./settings";

const IDS = ["hook", "bridge"];
// Paths from the extension root (the repo root; see manifest.json).
const HOOK = "dist/hook.js";
const BRIDGE = "dist/bridge.js";

/** (Re)registers the content scripts for every configured domain the user granted, and injects them into open tabs. */
export async function registerContentScripts(): Promise<void> {
  const { domains } = await getSettings();
  const granted: string[] = [];
  for (const d of domains) if (await chrome.permissions.contains({ origins: domainPatterns([d]) })) granted.push(d);

  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: IDS });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  if (!granted.length) return;
  const matches = domainPatterns(granted);
  await chrome.scripting.registerContentScripts([
    { id: "hook", js: [HOOK], matches, runAt: "document_start", world: "MAIN", allFrames: false },
    { id: "bridge", js: [BRIDGE], matches, runAt: "document_start", allFrames: false },
  ]);

  // Tabs opened before install/update or before a domain was added; both scripts guard against running twice.
  for (const tab of await chrome.tabs.query({ url: matches })) {
    if (tab.id == null || tab.discarded) continue;
    const target = { tabId: tab.id };
    await chrome.scripting.executeScript({ target, files: [HOOK], world: "MAIN" }).catch(() => {});
    await chrome.scripting.executeScript({ target, files: [BRIDGE] }).catch(() => {});
  }
}
