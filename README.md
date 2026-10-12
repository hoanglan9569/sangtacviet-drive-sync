# SangTacViet Drive Sync (Chrome extension)

Keeps your SangTacViet **reading history and names** the same in every browser, through your own Google Drive.

- Works on `sangtacviet.com` and `sangtacviet.app`; add more domains in Settings.
- Several Google accounts; pick the one this browser syncs with.
- Newer changes always win; a stale browser never overwrites them. Names added to the same book in two browsers are both kept.
- Drive also gets `SangTacViet Sync/dulieu.txt`, in the site's own export format. You can load it with the site's **Nhập lịch sử đọc và name** button.

## What it syncs

SangTacViet has no API for personal data. Everything lives in `localStorage`, and the site's **Tải xuống lịch sử đọc và name** button just dumps it:

| localStorage key | Content | Written by (site code) |
| --- | --- | --- |
| `tusach` | reading history: JSON entries joined by `~/~`, most recent first | `updateTusach` (opening a chapter), `removebookfromts` (✕), `clearOldHistory` |
| `<host><bookId>`, e.g. `qidian1050807668` | names of one book: `$中文=Việt` lines joined by `~//~` | `saveNS` (name editor, add name, auto-naming) |

The extension syncs exactly that set. It also syncs `dich…` (translated books) and `qtOnline0` (the shared name list), which the site's own export skips.

## How it works

```
page (MAIN world)   hook.js    wraps Storage.setItem/removeItem → "key X written at t"
content script      bridge.js  reads/writes localStorage for the background (compare-and-set)
service worker      background.js
                      on write (2 s debounce), page load, every 5 min, "Sync now":
                      1. diff localStorage vs. what it held after the last sync → changed items
                      2. merge other browsers' changes from Drive
                      3. upload a change file holding only what changed here
                      4. write the merged result back into the page if it did not change meanwhile
                      5. then update dulieu.txt; Drive keeps each upload as a version of it
```

- **Merge model:** a last-writer-wins element set (CRDT). Items are one book in the history, or one name line. Each item records when it last changed, and deleted items are kept as tombstones for 180 days. So merging is order-independent and never loses a newer change.
- **Files per browser**, found by `appProperties`. Each browser writes only its own, so two browsers syncing at the same moment cannot clobber each other:
  - `changes-<id>-<n>.json`: one per sync with changes, holding only the changed items (a chapter read is a few hundred bytes). Other browsers download only the ones they haven't merged.
  - `device-<id>.json`: all the data as of change *n*. Every 30 changes the change files are folded into it and deleted. A browser further behind than the change files reach reads this file instead.
  - Browsers on an older version of the extension still sync: they read and write the whole device file as before.
- **dulieu.txt and its versions** are written after the page is updated, so they don't delay the sync. A browser that only received changes writes neither. Versions are dulieu.txt's own Drive revisions, uploaded with "keep forever" (and marked so afterwards if Drive did not), so the data goes up once per change. Drive's **Manage versions** on dulieu.txt shows them too, each named after the browser and what it holds.
- **One translation per term.** The site uses one line per name term (`$伊莱=…`), so a list keeps one line per term, the newest change. That covers the site appending a renamed name and two browsers renaming the same term.
- **A browser joining** (first sync, or a page whose site data was cleared) is merged against the account's data and deletes nothing:
  - Books only one side has, and names only one side has, end up on both.
  - The same book on both: the further chapter wins.
  - A name term the account already translates differently: the account's translation stays.
  - Whatever the joining browser loses that way is saved first as a version ("its own data before joining").
- **Open pages stay consistent:** when synced names arrive for the chapter you have open, the name editor is updated, so the site's next save cannot drop them. On the home page, the history list redraws itself. A toast offers a reload.
- **Google sign-in:** `chrome.identity.launchWebAuthFlow` with scope `drive.file`, so the extension only sees files it created. Tokens are renewed silently. When Google wants you back, the popup shows **Sign in again**.

## Setup

Building needs [Bun](https://bun.sh).

```powershell
bun install
bun run build          # scripts and pages -> dist/
```

1. `chrome://extensions` → Developer mode → **Load unpacked** → this repo's folder (its `manifest.json` points into `dist/`). The ID is fixed by the manifest `key`: `dkgknammpnaadehadhbojamiogakmnhh`.
2. Create a Google OAuth client (once):
   - [console.cloud.google.com](https://console.cloud.google.com) → new project → enable **Google Drive API**.
   - **Google Auth Platform** → Get started: app name, support email, audience **External**, contact email.
   - **Branding**: fill in the home page and privacy policy links (e.g. this repo); **Publish app** stays disabled until you do.
   - **Audience → Publish app**: `drive.file` needs no review, and an app left in "Testing" loses its sign-in after 7 days.
   - **Credentials → OAuth client ID** → **Web application**. Authorized redirect URI: `https://dkgknammpnaadehadhbojamiogakmnhh.chromiumapp.org/`.
3. Put the client ID in the extension's **Settings**, or bake it in: `STV_GOOGLE_CLIENT_ID=… ` in `.env`, then `bun run build`.

## Usage

Click the toolbar icon.

1. **Connect Google account** and allow Drive access.
2. The popup checks that account's Drive:
   - Backup found → **Sync this browser** merges this browser into it.
   - Nothing there → **Start syncing** uploads this browser's data.
3. **+ Add another Google account** adds more accounts. The radio button picks the one this browser syncs with.
4. While syncing, the popup offers **Sync now**, **Download .txt** (the merged data in the site's format), the list of browsers on the account, and **Stop syncing in this browser**.

The ☾/☀ button next to Settings switches between light and dark mode.

Settings: domains (adding one asks for access to it), the OAuth client ID, and **Browsers**, the account's browsers. The list refreshes on its own. Click a browser to:

- **Rename** it. Another browser takes the new name at its next sync.
- **Remove** it. Its file goes to the Drive trash, and anything it already synced stays. That browser stops syncing with the account until it is linked again from its own popup. "Remove this browser" does the same for the current browser.

**Versions** keeps the account's data history in its Drive, as the version history of `SangTacViet Sync/dulieu.txt` (site format), like a Google Doc's. The card shows how many there are; click it to manage them:

- Every sync that changes the data saves a version, kept forever. Drive keeps at most 200 per file forever, so past 180 the oldest become temporary: Drive deletes those after 30 days. There is nothing to configure.
- Pick a version to **Restore** it, **Download** it as `.txt`, or **Delete** it. Restore replaces the data in every browser on the account; the data it replaces stays as a version. The **latest** version is dulieu.txt itself and can't be deleted.
- The list shows every version Drive shows under **Manage versions**, including **temporary** ones (not kept forever, e.g. uploaded by an older release). Those can be downloaded, restored and deleted too; Drive deletes them itself 30 days after a newer version, or sooner past 100.
- A joining browser's own data, and versions saved by older versions of the extension, are separate files in the folder (`dulieu before joining - …txt`, older `backup …txt`). They are listed too and stay until you delete them.
- Deleting dulieu.txt from Drive deletes its versions with it.
- The list refreshes on its own.

## Development

```powershell
bun run check          # typecheck + tests
bun run test/fake-drive.ts 8787 [--file state.json]   # fake Drive for manual/browser runs (set settings.driveBase)
```

| Path | |
| --- | --- |
| `manifest.json` | the extension manifest; the repo root is the unpacked extension |
| `src/shared/sitedata.ts` | the site's data format, name-key rule |
| `src/shared/model.ts` | items, merge, diff (pure) |
| `src/shared/engine.ts` | one sync round against Drive, versions |
| `src/shared/drive.ts` | Drive v3 calls |
| `src/shared/versions.ts` | versions: revision naming, which ones to keep forever (pure) |
| `src/background/` | service worker: auth, settings, scheduling, content-script registration |
| `src/content/` | `hook.ts` (page world), `bridge.ts` (content script) |
| `src/ui/` | popup, settings page (`versions.ts`: the Versions card and dialog) |
| `test/` | merge, engine, join, change-file (`journal.test.ts`) and version tests against `fake-drive.ts` |

Limits:

- A browser's changes reach Drive only while a SangTacViet tab is open. The site gives no other way to read its data.
- Clocks decide which concurrent change is newer, so a browser with a badly wrong clock can lose ties.
