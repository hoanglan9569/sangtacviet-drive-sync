/**
 * Settings page "Backups": a one-line card; a click opens a dialog with the
 * policy (versions per day, days kept) and the versions, where one can be
 * picked to restore, download or delete. Both stay current on their own.
 */
import type { BackupPolicy, BackupVersion } from "../shared/backups";
import type { Status } from "../shared/messages";
import { ago, busy, call, h } from "./common";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const dialog = $<HTMLDialogElement>("backups");
const perDay = $<HTMLInputElement>("per-day");
const days = $<HTMLInputElement>("days");

let status: Status | undefined;
let data: { sub: string; policy: BackupPolicy; versions: BackupVersion[] } | undefined;
let error = "";
let selected: string | undefined;
/** The policy inputs were edited and not saved yet: refreshes leave them alone. */
let editing = false;

const account = () => status?.accounts.find((a) => a.sub === status?.active);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
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
export function refreshBackups(): Promise<void> {
  inFlight ??= (async () => {
    try {
      status = await call<Status>({ type: "status" });
      const sub = status.active;
      data = sub ? { sub, ...(await call<{ policy: BackupPolicy; versions: BackupVersion[] }>({ type: "backups" })) } : undefined;
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
  const policy = data?.policy;
  if (selected && !versions.some((v) => v.id === selected)) selected = undefined;

  // The card: one line of policy, one of state.
  const summary = $("backups-summary");
  if (!a) summary.textContent = "Connect a Google account in the popup to keep backup versions.";
  else if (error && !data) summary.replaceChildren(h("span", { class: "error" }, error));
  else
    summary.replaceChildren(
      policy ? `${plural(policy.perDay, "version")} a day · kept ${plural(policy.days, "day")}` : "…",
      h("br"),
      versions.length ? `${plural(versions.length, "version")} · newest ${ago(versions[0]!.at)}` : a.linked ? "No versions yet: the next sync saves one." : "Start syncing this account to keep versions.",
    );

  // The dialog.
  $("backups-account").textContent = a ? `Versions of ${a.email}'s data, kept in its Google Drive.` : "";
  if (policy && !editing) {
    perDay.value = String(policy.perDay);
    days.value = String(policy.days);
  }
  $("backups-error").textContent = error;
  const groups = new Map<string, BackupVersion[]>();
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
              `${plural(v.books, "book")} · ${plural(v.names, "name")}`,
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
  $<HTMLButtonElement>("version-restore").disabled = none || !a?.linked;
  $<HTMLButtonElement>("backup-now").disabled = !a?.linked;
  $<HTMLButtonElement>("policy-save").disabled = !a;
}

function select(id: string): void {
  selected = id;
  render();
}

const fail = (e: string) => ($("backups-error").textContent = e);
const chosen = () => data?.versions.find((v) => v.id === selected);
const when = (v: BackupVersion) => `${dayLabel(v.day).toLowerCase()} at ${time(v.at)}`;

function open(): void {
  editing = false;
  render();
  dialog.showModal();
  void refreshBackups();
}

$("backups-card").addEventListener("click", open);
$("backups-card").addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open()));
$("backups-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (e) => e.target === dialog && dialog.close());
for (const input of [perDay, days]) input.addEventListener("input", () => (editing = true));

$("policy-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const policy = { perDay: Number(perDay.value), days: Number(days.value) };
  const old = data?.policy;
  const fewer = old && (policy.perDay < old.perDay || policy.days < old.days);
  if (fewer && !confirm("Keep fewer versions? Versions beyond the new limits are deleted now.")) return;
  void busy($<HTMLButtonElement>("policy-save"), "Saving…", async () => {
    await call({ type: "setBackupPolicy", policy });
    editing = false;
    await refreshBackups();
  }, fail);
});

$("backup-now").addEventListener("click", (e) =>
  void busy(e.currentTarget as HTMLButtonElement, "Saving…", async () => {
    await call({ type: "backupNow" });
    await refreshBackups();
  }, fail),
);

$("version-download").addEventListener("click", (e) => {
  const v = chosen();
  if (!v) return;
  void busy(e.currentTarget as HTMLButtonElement, "…", async () => {
    const text = await call<string>({ type: "downloadBackup", id: v.id });
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    h("a", { href: url, download: `dulieu-${v.day}-${new Date(v.at).toTimeString().slice(0, 5).replace(":", "")}.txt` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, fail);
});

$("version-delete").addEventListener("click", (e) => {
  const v = chosen();
  if (!v || !confirm(`Delete the version from ${when(v)}? This cannot be undone.`)) return;
  void busy(e.currentTarget as HTMLButtonElement, "Deleting…", async () => {
    await call({ type: "deleteBackup", id: v.id });
    await refreshBackups();
  }, fail);
});

$("version-restore").addEventListener("click", (e) => {
  const v = chosen();
  if (!v) return;
  const question =
    `Restore the version from ${when(v)} (${plural(v.books, "book")}, ${plural(v.names, "name")})?\n\n` +
    "Reading history and names in every browser on this account are replaced by it. The current data is saved as a version first.";
  if (!confirm(question)) return;
  void busy(e.currentTarget as HTMLButtonElement, "Restoring…", async () => {
    await call({ type: "restoreBackup", id: v.id });
    await refreshBackups();
  }, fail);
});

// Keep it current: syncs (which save and rotate versions) and account changes rewrite these keys.
let timer: ReturnType<typeof setTimeout> | undefined;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !Object.keys(changes).some((k) => k === "settings" || k.startsWith("remote:"))) return;
  clearTimeout(timer);
  timer = setTimeout(() => void refreshBackups(), 1000);
});
document.addEventListener("visibilitychange", () => !document.hidden && void refreshBackups());
setInterval(() => !document.hidden && void refreshBackups(), 60_000);
void refreshBackups();
