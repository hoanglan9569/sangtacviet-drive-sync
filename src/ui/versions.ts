/**
 * Settings page "Versions": a one-line card; a click opens a dialog with the
 * versions (dulieu.txt's version history), where one can be picked to restore,
 * download or delete. Both stay current on their own.
 */
import { type Version, KEEP_FOREVER } from "../shared/versions";
import type { Status } from "../shared/messages";
import { ago, busy, call, h } from "./common";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const dialog = $<HTMLDialogElement>("versions-dialog");

let status: Status | undefined;
let data: { sub: string; versions: Version[] } | undefined;
let error = "";
let selected: string | undefined;

const account = () => status?.accounts.find((a) => a.sub === status?.active);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** " (3 temporary)" when some versions are not kept forever. */
const temporary = (list: Version[]) => {
  const n = list.filter((v) => v.temporary).length;
  return n ? ` (${n} temporary)` : "";
};
/** "12 books · 340 names", or the size when Drive did not keep the counts. */
const what = (v: Version) =>
  v.books !== undefined && v.names !== undefined
    ? `${plural(v.books, "book")} · ${plural(v.names, "name")}`
    : v.size !== undefined
      ? `${Math.max(1, Math.round(v.size / 1024))} KB`
      : "";
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - d.getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

let inFlight: Promise<void> | undefined;
/** Lists the versions from Drive again, then redraws. */
export function refreshVersions(): Promise<void> {
  inFlight ??= (async () => {
    try {
      status = await call<Status>({ type: "status" });
      const sub = status.active;
      data = sub ? { sub, ...(await call<{ versions: Version[] }>({ type: "versions" })) } : undefined;
      error = "";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    render();
  })().finally(() => (inFlight = undefined));
  return inFlight;
}

function render(): void {
  const a = account();
  const versions = data?.sub === a?.sub ? (data?.versions ?? []) : [];
  if (selected && !versions.some((v) => v.id === selected)) selected = undefined;

  // The card: one line of state.
  const summary = $("versions-summary");
  if (!a) summary.textContent = "Connect a Google account in the popup to keep versions.";
  else if (error && !data) summary.replaceChildren(h("span", { class: "error" }, error));
  else
    summary.replaceChildren(
      !data ? "…" : versions.length ? `${plural(versions.length, "version")}${temporary(versions)} · newest ${ago(versions[0]!.at)}` : a.linked ? "No versions yet: the next sync saves one." : "Start syncing this account to keep versions.",
    );

  // The dialog.
  $("versions-error").textContent = error;
  const groups = new Map<string, Version[]>();
  for (const v of versions) groups.set(v.day, [...(groups.get(v.day) ?? []), v]);
  $("versions").replaceChildren(
    ...(versions.length ? [] : [h("p", { class: "muted small" }, "No versions yet.")]),
    ...[...groups].flatMap(([day, list]) => [
      h("h3", {}, dayLabel(day)),
      ...list.map((v) =>
        h(
          "label",
          { class: `version${v.id === selected ? " selected" : ""}` },
          h("input", { type: "radio", name: "version", value: v.id, checked: v.id === selected, onchange: () => select(v.id) }),
          h("b", {}, time(v.at)),
          h(
            "small",
            { class: "muted" },
            [
              v.current ? "latest" : "",
              v.temporary ? "temporary" : "",
              what(v),
              v.deviceName,
              v.reason === "manual" ? "saved by hand" : v.reason === "restore" ? "saved before a restore" : v.reason === "join" ? "its own data before joining" : "",
            ]
              .filter(Boolean)
              .join(" · "),
          ),
        ),
      ),
    ]),
  );
  const none = !selected;
  for (const id of ["version-download", "version-delete", "version-restore"]) $<HTMLButtonElement>(id).disabled = none;
  const current = !!chosen()?.current;
  $<HTMLButtonElement>("version-delete").disabled = none || current;
  $<HTMLButtonElement>("version-delete").title = current ? "The latest version is dulieu.txt's current content and can't be deleted." : "";
  $<HTMLButtonElement>("version-restore").disabled = none || !a?.linked;
  $<HTMLButtonElement>("version-save-now").disabled = !a?.linked;
}

function select(id: string): void {
  selected = id;
  render();
}

const fail = (e: string) => ($("versions-error").textContent = e);
const chosen = () => data?.versions.find((v) => v.id === selected);
const when = (v: Version) => `${dayLabel(v.day).toLowerCase()} at ${time(v.at)}`;

function open(): void {
  render();
  dialog.showModal();
  void refreshVersions();
}

$("versions-card").addEventListener("click", open);
$("versions-card").addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open()));
$("versions-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (e) => e.target === dialog && dialog.close());
$("keep-forever").textContent = String(KEEP_FOREVER);

$("version-save-now").addEventListener("click", (e) =>
  void busy(e.currentTarget as HTMLButtonElement, "Saving…", async () => {
    await call({ type: "saveVersion" });
    await refreshVersions();
  }, fail),
);

$("version-download").addEventListener("click", (e) => {
  const v = chosen();
  if (!v) return;
  void busy(e.currentTarget as HTMLButtonElement, "…", async () => {
    const text = await call<string>({ type: "downloadVersion", id: v.id });
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    h("a", { href: url, download: `dulieu-${v.day}-${new Date(v.at).toTimeString().slice(0, 5).replace(":", "")}.txt` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, fail);
});

$("version-delete").addEventListener("click", (e) => {
  const v = chosen();
  if (!v || !confirm(`Delete the version from ${when(v)}? This cannot be undone.`)) return;
  void busy(e.currentTarget as HTMLButtonElement, "Deleting…", async () => {
    await call({ type: "deleteVersion", id: v.id });
    await refreshVersions();
  }, fail);
});

$("version-restore").addEventListener("click", (e) => {
  const v = chosen();
  if (!v) return;
  const question =
    `Restore the version from ${when(v)}${what(v) ? ` (${what(v).replace(" · ", ", ")})` : ""}?\n\n` +
    "Reading history and names in every browser on this account are replaced by it. The data it replaces stays as a version.";
  if (!confirm(question)) return;
  void busy(e.currentTarget as HTMLButtonElement, "Restoring…", async () => {
    await call({ type: "restoreVersion", id: v.id });
    await refreshVersions();
  }, fail);
});

// Keep it current: syncs (which save and rotate versions) and account changes rewrite these keys.
let timer: ReturnType<typeof setTimeout> | undefined;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !Object.keys(changes).some((k) => k === "settings" || k.startsWith("remote:"))) return;
  clearTimeout(timer);
  timer = setTimeout(() => void refreshVersions(), 1000);
});
document.addEventListener("visibilitychange", () => !document.hidden && void refreshVersions());
setInterval(() => !document.hidden && void refreshVersions(), 60_000);
void refreshVersions();
