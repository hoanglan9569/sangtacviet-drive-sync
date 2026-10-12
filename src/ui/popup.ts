import type { RemoteSummary } from "../shared/engine";
import type { AccountView, Status } from "../shared/messages";
import { ago, busy, call, h } from "./common";

const app = document.getElementById("app")!;
let error = "";
let summary: { sub: string; value?: RemoteSummary; error?: string } | undefined;

document.getElementById("settings")!.addEventListener("click", () => chrome.runtime.openOptionsPage());
chrome.runtime.onMessage.addListener((m: { type?: string }) => {
  if (m.type === "changed") void render();
});

const fail = (e: string) => {
  error = e;
  void render();
};

async function render(): Promise<void> {
  let s: Status;
  try {
    s = await call<Status>({ type: "status" });
  } catch (e) {
    app.replaceChildren(h("p", { class: "error" }, String(e)));
    return;
  }
  const parts: Node[] = [];
  if (error) parts.push(h("p", { class: "error", onclick: () => ((error = ""), render()) }, error));

  if (!s.clientId) {
    parts.push(
      h(
        "section",
        { class: "card" },
        h("h2", {}, "One-time setup"),
        h("p", {}, "Paste your Google OAuth client ID in Settings to enable Google sign-in. The README explains how to create one."),
        h("button", { class: "primary", onclick: () => chrome.runtime.openOptionsPage() }, "Open settings"),
      ),
    );
    app.replaceChildren(...parts);
    return;
  }

  parts.push(accountsCard(s));
  const active = s.accounts.find((a) => a.sub === s.active);
  if (active) parts.push(active.linked ? syncCard(s, active) : linkCard(s, active));
  parts.push(h("footer", {}, `Sites: ${s.domains.join(", ")}`));
  app.replaceChildren(...parts);
}

function accountsCard(s: Status): HTMLElement {
  const rows = s.accounts.map((a) =>
    h(
      "label",
      { class: `account${a.sub === s.active ? " active" : ""}` },
      h("input", {
        type: "radio",
        name: "active",
        checked: a.sub === s.active,
        onchange: () => call({ type: "setActive", sub: a.sub }).then(render, (e: Error) => fail(e.message)),
      }),
      a.picture ? h("img", { src: a.picture, alt: "", class: "avatar", referrerpolicy: "no-referrer" }) : h("span", { class: "avatar" }, (a.email[0] ?? "?").toUpperCase()),
      h("span", { class: "who" }, h("b", {}, a.name || a.email), a.name ? h("small", {}, a.email) : null),
      a.needsAuth
        ? h("span", { class: "badge warn" }, "Sign in")
        : a.linked
          ? h("span", { class: "badge ok" }, "Sync on")
          : null,
      h("button", {
        class: "icon",
        title: `Remove ${a.email} from this browser`,
        onclick: (e: Event) => {
          e.preventDefault();
          if (confirm(`Remove ${a.email} from this browser? The backup in its Drive stays.`))
            call({ type: "removeAccount", sub: a.sub }).then(render, (err: Error) => fail(err.message));
        },
      }, "×"),
    ),
  );
  const add = h("button", { class: s.accounts.length ? "link" : "primary" }, s.accounts.length ? "+ Add another Google account" : "Connect Google account");
  add.addEventListener("click", () => void busy(add, "Waiting for Google…", () => call({ type: "addAccount" }).then(render), fail));
  return h(
    "section",
    { class: "card" },
    h("h2", {}, s.accounts.length > 1 ? "Google account to sync with" : "Google account"),
    s.accounts.length ? h("div", { class: "accounts" }, ...rows) : h("p", { class: "muted" }, "Connect a Google account to back up your reading history and names to its Google Drive."),
    add,
  );
}

function reconnectNotice(a: AccountView): HTMLElement | null {
  if (!a.needsAuth) return null;
  const btn = h("button", { class: "primary" }, "Sign in again");
  btn.addEventListener("click", () => void busy(btn, "Waiting for Google…", () => call({ type: "reconnect", sub: a.sub }).then(render), fail));
  return h("div", { class: "notice warn" }, h("p", {}, `Google needs you to sign in to ${a.email} again.`), btn);
}

function linkCard(s: Status, a: AccountView): HTMLElement {
  const card = h("section", { class: "card" }, h("h2", {}, "Google Drive"));
  const notice = reconnectNotice(a);
  if (notice) {
    card.append(notice);
    return card;
  }
  if (summary?.sub !== a.sub) {
    summary = { sub: a.sub };
    call<RemoteSummary>({ type: "summary" }).then(
      (value) => ((summary = { sub: a.sub, value }), render()),
      (e: Error) => ((summary = { sub: a.sub, error: e.message }), render()),
    );
  }
  if (summary.error) {
    card.append(h("p", { class: "error" }, summary.error));
    return card;
  }
  if (!summary.value) {
    card.append(h("p", { class: "muted" }, "Checking Google Drive…"));
    return card;
  }
  const r = summary.value;
  const others = r.devices.filter((d) => !d.self);
  const btn = h("button", { class: "primary" }, r.exists ? "Sync this browser" : "Start syncing");
  btn.addEventListener("click", () => void busy(btn, "Syncing…", () => call({ type: "link" }).then(render), fail));
  card.append(
    r.exists
      ? h(
          "p",
          {},
          `A backup already exists in this Drive${others.length ? ` (from ${others.map((d) => d.name).join(", ")})` : ""}, updated ${ago(r.exportUpdated ?? others[0]?.updated)}. `,
          "Syncing merges this browser's reading history and names with it — newer changes win, nothing newer is overwritten.",
        )
      : h("p", {}, "No backup in this Drive yet. Syncing uploads this browser's reading history and names, then keeps them up to date."),
    btn,
  );
  if (!s.openTabs) card.append(h("p", { class: "muted small" }, "This browser's data is read from an open SangTacViet tab; it is picked up the next time one is open."));
  return card;
}

function syncCard(s: Status, a: AccountView): HTMLElement {
  const card = h("section", { class: "card" }, h("h2", {}, "Google Drive sync"));
  const notice = reconnectNotice(a);
  if (notice) card.append(notice);
  const state = s.syncing
    ? h("p", { class: "status busy" }, "Syncing…")
    : s.lastError
      ? h("p", { class: "status bad" }, s.lastError)
      : h("p", { class: "status good" }, `Up to date · synced ${ago(s.lastSync)}`);
  card.append(state);
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;
  if (s.counts) card.append(h("p", { class: "muted" }, `${n(s.counts.books, "book")} in history · ${n(s.counts.names, "name")} in ${n(s.counts.nameLists, "book")}`));

  const now = h("button", { class: "primary" }, "Sync now");
  now.addEventListener("click", () => void busy(now, "Syncing…", () => call({ type: "syncNow" }).then(render), fail));
  const dl = h("button", {}, "Download .txt");
  dl.addEventListener("click", () =>
    void busy(dl, "Preparing…", async () => {
      const text = await call<string>({ type: "export" });
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
      const link = h("a", { href: url, download: `dulieu${new Date().toJSON().slice(0, 10)}.txt` });
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, fail),
  );
  card.append(h("div", { class: "row" }, now, dl));

  if (s.devices.length) {
    card.append(
      h("h3", {}, "Browsers on this account"),
      h("ul", { class: "devices" }, ...s.devices.map((d) => h("li", {}, h("span", {}, d.self ? `${d.name} (this browser)` : d.name), h("small", {}, ago(d.updated))))),
    );
  }
  const stop = h("button", { class: "link danger" }, "Stop syncing in this browser");
  stop.addEventListener("click", () => {
    if (confirm("Stop syncing this browser? Data already in Drive and in this browser stays.")) void busy(stop, "…", () => call({ type: "unlink" }).then(() => ((summary = undefined), render())), fail);
  });
  card.append(stop);
  return card;
}

void render();
