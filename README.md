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
                      2. merge other browsers' device files from Drive
                      3. upload this browser's device file + dulieu.txt if changed
                      4. write the merged result back into the page if it did not change meanwhile
```

- **Merge model:** a last-writer-wins element set (CRDT). Items are one book in the history, or one name line. Each item records when it last changed, and deleted items are kept as tombstones for 180 days. So merging is order-independent and never loses a newer change.
- **One file per browser** (`device-<id>.json`, found by `appProperties`). Each browser writes only its own file, so two browsers syncing at the same moment cannot clobber each other.
- **First sync of a browser** merges and deletes nothing. If two browsers both have the same book, the one at the further chapter wins.
- **Open pages stay consistent:** when synced names arrive for the chapter you have open, the name editor is updated, so the site's next save cannot drop them. On the home page, the history list redraws itself. A toast offers a reload.
- **Google sign-in:** `chrome.identity.launchWebAuthFlow` with scope `drive.file`, so the extension only sees files it created. Tokens are renewed silently. When Google wants you back, the popup shows **Sign in again**.

## Setup

Building needs [Bun](https://bun.sh).

```powershell
bun install
bun run build          # -> dist/extension
```

1. `chrome://extensions` → Developer mode → **Load unpacked** → `dist/extension`. The ID is fixed by the manifest `key`: `dkgknammpnaadehadhbojamiogakmnhh`.
2. Create a Google OAuth client (once):
   - [console.cloud.google.com](https://console.cloud.google.com) → new project → enable **Google Drive API**.
   - **OAuth consent screen**: External. Scopes: `openid`, `email`, `profile`, `.../auth/drive.file`. Then **Publish app**: `drive.file` needs no review, and an app left in "Testing" loses its sign-in after 7 days.
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

Settings: domains (adding one asks for access to it), OAuth client ID, and the name other browsers see for this one.

## Development

```powershell
bun run check          # typecheck + tests
bun run test/fake-drive.ts 8787 [--file state.json]   # fake Drive for manual/browser runs (set settings.driveBase)
```

| Path | |
| --- | --- |
| `src/shared/sitedata.ts` | the site's data format, name-key rule |
| `src/shared/model.ts` | items, merge, diff (pure) |
| `src/shared/engine.ts` | one sync round against Drive |
| `src/shared/drive.ts` | Drive v3 calls |
| `src/background/` | service worker: auth, settings, scheduling, content-script registration |
| `src/content/` | `hook.ts` (page world), `bridge.ts` (content script) |
| `src/ui/` | popup, settings page |
| `test/` | merge/engine tests against `fake-drive.ts` |

Limits:

- A browser's changes reach Drive only while a SangTacViet tab is open. The site gives no other way to read its data.
- Clocks decide which concurrent change is newer, so a browser with a badly wrong clock can lose ties.
