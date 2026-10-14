// src/background/settings.ts
var DEFAULT_DOMAINS = ["sangtacviet.com", "sangtacviet.app"];
var local = {
  async get(key) {
    return (await chrome.storage.local.get(key))[key];
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(key) {
    await chrome.storage.local.remove(key);
  }
};
function defaultDeviceName() {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : "Chrome";
  return `${browser}${os ? ` on ${os}` : ""}`;
}
var deviceInit;
function ensureDevice() {
  deviceInit ??= (async () => {
    const stored = await local.get("device");
    if (stored)
      return stored;
    const device = { id: crypto.randomUUID().slice(0, 8), name: defaultDeviceName() };
    await local.set("device", device);
    return device;
  })();
  return deviceInit;
}
async function getSettings() {
  const s = await local.get("settings") ?? {};
  return {
    device: await local.get("device") ?? await ensureDevice(),
    domains: s.domains ?? DEFAULT_DOMAINS,
    accounts: s.accounts ?? [],
    active: s.active,
    linked: s.linked ?? {},
    hosts: s.hosts ?? [],
    driveBase: s.driveBase
  };
}
async function updateSettings(fn) {
  const raw = await local.get("settings") ?? {};
  const next = { ...raw, ...fn(await getSettings()) };
  await local.set("settings", next);
  return getSettings();
}
async function getAccountStatus(sub) {
  return await local.get(`status:${sub}`) ?? {};
}
async function setAccountStatus(sub, patch) {
  await local.set(`status:${sub}`, { ...await getAccountStatus(sub), ...patch });
}
function domainPatterns(domains) {
  return domains.flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]);
}
function matchesDomain(url, domains) {
  if (!url)
    return false;
  try {
    const host = new URL(url).hostname;
    return domains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

// src/background/auth.ts
var CLIENT_ID = "415848440355-t5p3rnos93lac5v1trt6tgl1udcbmamr.apps.googleusercontent.com";
var SCOPES = ["openid", "email", "profile", "https://www.googleapis.com/auth/drive.file"];
var DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

class AuthError extends Error {
}
async function flow(o) {
  const state = crypto.randomUUID();
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: chrome.identity.getRedirectURL(),
    response_type: "token",
    scope: SCOPES.join(" "),
    include_granted_scopes: "true",
    state
  });
  if (o.loginHint)
    p.set("login_hint", o.loginHint);
  if (o.prompt)
    p.set("prompt", o.prompt);
  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({
      url: `https://accounts.google.com/o/oauth2/v2/auth?${p}`,
      interactive: o.interactive,
      ...o.interactive ? {} : { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 15000 }
    });
  } catch (e) {
    throw new AuthError(e instanceof Error ? e.message : String(e));
  }
  if (!redirect)
    throw new AuthError("Sign-in was cancelled.");
  const r = new URLSearchParams(new URL(redirect).hash.slice(1));
  if (r.get("error"))
    throw new AuthError(`Google sign-in: ${r.get("error")}`);
  if (r.get("state") !== state)
    throw new AuthError("Google sign-in: state mismatch.");
  if (!(r.get("scope") ?? "").split(" ").includes(DRIVE_SCOPE))
    throw new AuthError("Google Drive access was not granted. Add the account again and allow Drive access.");
  return { token: r.get("access_token") ?? "", exp: Date.now() + Number(r.get("expires_in") ?? 3600) * 1000 };
}
async function userInfo(token) {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok)
    throw new AuthError(`Google userinfo: ${res.status}`);
  const u = await res.json();
  return { sub: u.sub, email: u.email, name: u.name, picture: u.picture };
}
var tokenKey = (sub) => `token:${sub}`;
async function saveToken(sub, t) {
  await chrome.storage.session.set({ [tokenKey(sub)]: t });
  await setAccountStatus(sub, { needsAuth: false });
}
async function addAccount() {
  const t = await flow({ interactive: true, prompt: "select_account" });
  const account = await userInfo(t.token);
  await saveToken(account.sub, t);
  await updateSettings((s) => ({
    accounts: [...s.accounts.filter((a) => a.sub !== account.sub), account],
    active: s.active ?? account.sub
  }));
  return account;
}
async function reconnect(account) {
  const t = await flow({ interactive: true, loginHint: account.email });
  const who = await userInfo(t.token);
  if (who.sub !== account.sub)
    throw new AuthError(`That was ${who.email}, not ${account.email}.`);
  await saveToken(account.sub, t);
}
var inflight = new Map;
function tokenFor(account, stale) {
  const running = inflight.get(account.sub);
  if (running)
    return running;
  const p = (async () => {
    const cached = (await chrome.storage.session.get(tokenKey(account.sub)))[tokenKey(account.sub)];
    if (cached && cached.token !== stale && cached.exp > Date.now() + 60000)
      return cached.token;
    try {
      const t = await flow({ interactive: false, loginHint: account.email, prompt: "none" });
      if ((await userInfo(t.token)).sub !== account.sub)
        throw new AuthError("Signed in as a different account.");
      await saveToken(account.sub, t);
      return t.token;
    } catch (e) {
      await setAccountStatus(account.sub, { needsAuth: true });
      throw e instanceof AuthError ? e : new AuthError(String(e));
    }
  })().finally(() => inflight.delete(account.sub));
  inflight.set(account.sub, p);
  return p;
}
async function signOut(sub) {
  await chrome.storage.session.remove(tokenKey(sub));
}

// src/background/scripts.ts
var IDS = ["hook", "bridge"];
var HOOK = "dist/hook.js";
var BRIDGE = "dist/bridge.js";
async function registerContentScripts() {
  const { domains } = await getSettings();
  const granted = [];
  for (const d of domains)
    if (await chrome.permissions.contains({ origins: domainPatterns([d]) }))
      granted.push(d);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: IDS });
  if (existing.length)
    await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  if (!granted.length)
    return;
  const matches = domainPatterns(granted);
  await chrome.scripting.registerContentScripts([
    { id: "hook", js: [HOOK], matches, runAt: "document_start", world: "MAIN", allFrames: false },
    { id: "bridge", js: [BRIDGE], matches, runAt: "document_start", allFrames: false }
  ]);
  for (const tab of await chrome.tabs.query({ url: matches })) {
    if (tab.id == null || tab.discarded)
      continue;
    const target = { tabId: tab.id };
    await chrome.scripting.executeScript({ target, files: [HOOK], world: "MAIN" }).catch(() => {});
    await chrome.scripting.executeScript({ target, files: [BRIDGE] }).catch(() => {});
  }
}

// src/shared/drive.ts
var DRIVE_BASE = "https://www.googleapis.com";
var FOLDER_MIME = "application/vnd.google-apps.folder";
var FIELDS = "id,name,mimeType,md5Checksum,modifiedTime,createdTime,trashed,appProperties";
var REVISION_FIELDS = "id,modifiedTime,keepForever,md5Checksum,size,originalFilename";
var quote = (s) => `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

class DriveError extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class Drive {
  token;
  base;
  constructor(token, base = DRIVE_BASE) {
    this.token = token;
    this.base = base;
  }
  async call(path, init = {}) {
    let token = await this.token();
    for (let attempt = 0;; attempt++) {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      const res = await fetch(this.base + path, { ...init, headers });
      if (res.ok)
        return res;
      if (res.status === 401 && attempt === 0) {
        token = await this.token(token);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        if (body.error?.message)
          message = body.error.message;
      } catch {}
      throw new DriveError(res.status, `Google Drive: ${message}`);
    }
  }
  async list(q) {
    const out = [];
    let pageToken = "";
    do {
      const p = new URLSearchParams({ q, spaces: "drive", pageSize: "1000", fields: `nextPageToken,files(${FIELDS})` });
      if (pageToken)
        p.set("pageToken", pageToken);
      const body = await (await this.call(`/drive/v3/files?${p}`)).json();
      out.push(...body.files);
      pageToken = body.nextPageToken ?? "";
    } while (pageToken);
    return out;
  }
  async byKind(kind) {
    const files = await this.list(`appProperties has { key='stvSync' and value='${kind}' } and trashed=false`);
    return files.sort((a, b) => (a.createdTime ?? "").localeCompare(b.createdTime ?? ""));
  }
  async download(id) {
    return (await this.call(`/drive/v3/files/${encodeURIComponent(id)}?alt=media`)).text();
  }
  async get(id) {
    return (await this.call(`/drive/v3/files/${encodeURIComponent(id)}?fields=${FIELDS}`)).json();
  }
  async remove(id) {
    await this.call(`/drive/v3/files/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  async patch(id, meta) {
    const res = await this.call(`/drive/v3/files/${encodeURIComponent(id)}?fields=${FIELDS}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(meta)
    });
    return res.json();
  }
  async createFolder(meta) {
    const res = await this.call(`/drive/v3/files?fields=${FIELDS}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ ...meta, mimeType: FOLDER_MIME })
    });
    return res.json();
  }
  async multipart(method, path, meta, content, contentType, opts = {}) {
    const boundary = `stv${crypto.randomUUID().replaceAll("-", "")}`;
    const body = `--${boundary}\r
Content-Type: application/json; charset=UTF-8\r
\r
${JSON.stringify(meta)}\r
` + `--${boundary}\r
Content-Type: ${contentType}\r
\r
${content}\r
--${boundary}--`;
    const keep = opts.keepForever ? "&keepRevisionForever=true" : "";
    const res = await this.call(`${path}?uploadType=multipart&fields=${FIELDS}${keep}`, {
      method,
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body
    });
    return res.json();
  }
  create(meta, content, contentType, opts) {
    return this.multipart("POST", "/upload/drive/v3/files", meta, content, contentType, opts);
  }
  update(id, content, contentType, meta = {}, opts) {
    const { parents: _p, ...rest } = meta;
    return this.multipart("PATCH", `/upload/drive/v3/files/${encodeURIComponent(id)}`, rest, content, contentType, opts);
  }
  async revisions(fileId) {
    const out = [];
    let pageToken = "";
    do {
      const p = new URLSearchParams({ pageSize: "1000", fields: `nextPageToken,revisions(${REVISION_FIELDS})` });
      if (pageToken)
        p.set("pageToken", pageToken);
      const body = await (await this.call(`/drive/v3/files/${encodeURIComponent(fileId)}/revisions?${p}`)).json();
      out.push(...body.revisions ?? []);
      pageToken = body.nextPageToken ?? "";
    } while (pageToken);
    return out;
  }
  async downloadRevision(fileId, revisionId) {
    return (await this.call(`/drive/v3/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}?alt=media`)).text();
  }
  async keepRevision(fileId, revisionId, keepForever) {
    await this.call(`/drive/v3/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}?fields=id`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ keepForever })
    });
  }
  async removeRevision(fileId, revisionId) {
    await this.call(`/drive/v3/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}`, { method: "DELETE" });
  }
}

// src/shared/sitedata.ts
var ENTRY_SEP = "~/~";
var LINE_SEP = "~//~";
function splitEntries(tusach) {
  return tusach ? tusach.split(ENTRY_SEP).filter((e) => e !== "") : [];
}
function splitLines(value) {
  return value ? value.split(LINE_SEP).filter((l) => l.trim() !== "") : [];
}
function joinLines(lines) {
  return lines.length ? lines.join(LINE_SEP) + LINE_SEP : "";
}
function parseEntry(entry) {
  try {
    const e = JSON.parse(entry);
    return e && typeof e === "object" && e.host != null && e.id != null ? e : null;
  } catch {
    return null;
  }
}
function chapterOrder(entry) {
  const current = parseEntry(entry)?.current ?? "";
  const title = current.split("-,-")[1] ?? "";
  const m = /\d+/.exec(title);
  return m ? Number(m[0]) : 0;
}
function toExport(s) {
  const out = { name: { ...s.names } };
  if (s.tusach)
    out.tusach = s.tusach;
  return out;
}
function fromExport(f) {
  return { tusach: f.tusach ?? null, names: { ...f.name ?? {} } };
}

// src/shared/model.ts
var T = "t\x1F";
var N = "n\x1F";
var SEP = "\x1F";
var isEntryKey = (k) => k.startsWith(T);
function entryKey(entry) {
  const e = parseEntry(entry);
  return e ? `${T}${e.host}-${e.id}` : `${T}?${entry}`;
}
var lineKey = (nameKey, line) => `${N}${nameKey}${SEP}${line}`;
function splitLineKey(k) {
  const i = k.indexOf(SEP, N.length);
  return [k.slice(N.length, i), k.slice(i + 1)];
}
function liveItems(s) {
  const values = new Map;
  const order = [];
  for (const e of splitEntries(s.tusach)) {
    const k = entryKey(e);
    if (values.has(k))
      continue;
    values.set(k, e);
    order.push(k);
  }
  for (const [nk, v] of Object.entries(s.names))
    for (const line of splitLines(v))
      values.set(lineKey(nk, line), "");
  return { values, order };
}
var cmpValue = (a, b) => a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1;
function wins(inc, cur) {
  if (!cur)
    return true;
  if (inc.t !== cur.t)
    return inc.t > cur.t;
  return cmpValue(inc.v, cur.v) > 0;
}
function mergeItems(into, from) {
  let changed = false;
  for (const [k, inc] of Object.entries(from)) {
    if (wins(inc, into[k])) {
      into[k] = { t: inc.t, v: inc.v };
      changed = true;
    }
  }
  return changed;
}
function absorbLocal(items, local, shadow, o) {
  const L = liveItems(local);
  let changed = false;
  const put = (k, it) => {
    if (!wins(it, items[k]))
      return;
    items[k] = it;
    o.touched?.add(k);
    changed = true;
  };
  const timeOf = (k) => Math.min(o.now, o.times?.[isEntryKey(k) ? "tusach" : splitLineKey(k)[0]] ?? o.now);
  if (!shadow) {
    const base = Math.min(o.now, o.stamp ?? o.now);
    const rank = new Map(L.order.map((k, i) => [k, i]));
    const lineRank = new Map;
    for (const [nk, v] of Object.entries(local.names)) {
      const lines = splitLines(v);
      lines.forEach((line, i) => lineRank.set(lineKey(nk, line), lines.length - i));
    }
    const terms = liveTerms(items);
    const clashes = (k) => {
      const tk = termKey(k);
      return tk !== null && (terms.get(tk) ?? []).some((other) => other !== k);
    };
    for (const [k, v] of L.values) {
      const t = isEntryKey(k) ? base - (rank.get(k) ?? L.order.length) : base - L.order.length - (lineRank.get(k) ?? 0);
      const cur = items[k];
      if (!isEntryKey(k) && cur?.v !== v && clashes(k))
        continue;
      if (!cur)
        put(k, { t, v });
      else if (cur.v === null)
        put(k, { t: Math.max(t, cur.t + 1), v });
      else if (cur.v !== v && chapterOrder(v) > chapterOrder(cur.v))
        put(k, { t: Math.max(t, cur.t + 1), v });
    }
    return changed;
  }
  const S = liveItems(shadow);
  const rank = new Map(L.order.map((k, i) => [k, i]));
  const stamped = (k, v) => {
    const cur = items[k];
    const t = timeOf(k) - (rank.get(k) ?? 0);
    return cur && S.values.get(k) === cur.v ? { t: Math.max(t, cur.t + 1), v } : { t, v };
  };
  for (const [k, v] of L.values) {
    if (S.values.get(k) === v || items[k]?.v === v)
      continue;
    put(k, stamped(k, v));
  }
  for (const k of S.values.keys()) {
    if (L.values.has(k) || items[k]?.v == null)
      continue;
    put(k, stamped(k, null));
  }
  const first = L.order[0];
  const prevFirst = S.order[0];
  if (first && prevFirst && first !== prevFirst && L.values.has(prevFirst) && items[first]?.v === L.values.get(first)) {
    const cur = items[first];
    put(first, { t: Math.max(timeOf(first), cur.t + 1), v: cur.v });
  }
  return changed;
}
function buildSnapshot(items, base) {
  const entries = [];
  const lines = new Map;
  for (const [k, it] of Object.entries(items)) {
    if (it.v === null)
      continue;
    if (isEntryKey(k))
      entries.push([k, it]);
    else {
      const [nk, line] = splitLineKey(k);
      let l = lines.get(nk);
      if (!l)
        lines.set(nk, l = []);
      l.push([line, it.t]);
    }
  }
  entries.sort(([ka, a], [kb, b]) => b.t - a.t || (ka < kb ? -1 : ka > kb ? 1 : 0));
  const tusach = entries.length ? entries.map(([, it]) => it.v).join(ENTRY_SEP) : base.tusach === null ? null : "";
  const names = {};
  for (const nk of new Set([...Object.keys(base.names), ...lines.keys()])) {
    const want = lines.get(nk) ?? [];
    const baseLines = splitLines(base.names[nk]);
    const wantSet = new Set(want.map(([l]) => l));
    if (sameSet(baseLines, wantSet)) {
      names[nk] = base.names[nk] ?? "";
      continue;
    }
    const kept = [...new Set(baseLines.filter((l) => wantSet.has(l)))];
    const keptSet = new Set(kept);
    const added = want.filter(([l]) => !keptSet.has(l)).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
    names[nk] = joinLines([...kept, ...added.map(([l]) => l)]);
  }
  return { tusach, names };
}
function sameSet(lines, set) {
  const s = new Set(lines);
  if (s.size !== set.size)
    return false;
  for (const l of s)
    if (!set.has(l))
      return false;
  return true;
}
function planWrites(local, desired) {
  const plan = { expect: {}, set: {} };
  const a = splitEntries(local.tusach);
  const b = splitEntries(desired.tusach);
  if (a.length !== b.length || a.some((e, i) => e !== b[i])) {
    plan.expect.tusach = local.tusach;
    plan.set.tusach = desired.tusach;
  }
  for (const [nk, v] of Object.entries(desired.names)) {
    const cur = local.names[nk] ?? null;
    if (cur === v || sameSet(splitLines(cur), new Set(splitLines(v))))
      continue;
    plan.expect[nk] = cur;
    plan.set[nk] = v;
  }
  return plan;
}
var isEmptyPlan = (p) => Object.keys(p.set).length === 0;
function applyPlan(s, p) {
  const out = { tusach: s.tusach, names: { ...s.names } };
  for (const [k, v] of Object.entries(p.set)) {
    if (k === "tusach")
      out.tusach = v;
    else if (v === null)
      delete out.names[k];
    else
      out.names[k] = v;
  }
  return out;
}
function dropTombstones(items, before) {
  let changed = false;
  for (const [k, it] of Object.entries(items)) {
    if (it.v === null && it.t < before) {
      delete items[k];
      changed = true;
    }
  }
  return changed;
}
function counts(items) {
  let books = 0;
  let names = 0;
  const lists = new Set;
  for (const [k, it] of Object.entries(items)) {
    if (it.v === null)
      continue;
    if (isEntryKey(k))
      books++;
    else {
      names++;
      lists.add(splitLineKey(k)[0]);
    }
  }
  return { books, nameLists: lists.size, names };
}
var EMPTY = { tusach: null, names: {} };
function replaceWith(items, s, now) {
  const L = liveItems(s);
  let base = now;
  for (const it of Object.values(items))
    base = Math.max(base, it.t + 1);
  base += L.order.length;
  const rank = new Map(L.order.map((k, i) => [k, i]));
  for (const [k, it] of Object.entries(items))
    if (it.v !== null && !L.values.has(k))
      items[k] = { t: base, v: null };
  for (const [k, v] of L.values)
    items[k] = { t: base - (rank.get(k) ?? 0), v };
}
function termKey(k) {
  if (isEntryKey(k))
    return null;
  const [nk, line] = splitLineKey(k);
  const eq = line.indexOf("=");
  return eq > 0 ? `${nk}${SEP}${line.slice(0, eq)}` : null;
}
function liveTerms(items) {
  const out = new Map;
  for (const [k, it] of Object.entries(items)) {
    const tk = it.v === null ? null : termKey(k);
    if (tk !== null)
      out.set(tk, [...out.get(tk) ?? [], k]);
  }
  return out;
}
function resolveTerms(items, touched) {
  let changed = false;
  for (const keys of liveTerms(items).values()) {
    if (keys.length < 2)
      continue;
    const winner = keys.reduce((a, b) => wins({ t: items[b].t, v: b }, { t: items[a].t, v: a }) ? b : a);
    for (const k of keys) {
      if (k === winner)
        continue;
      items[k] = { t: items[k].t + 1, v: null };
      touched?.add(k);
      changed = true;
    }
  }
  return changed;
}

// src/shared/versions.ts
var KEEP_FOREVER = 180;
var pad = (n) => String(n).padStart(2, "0");
function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function versionFrom(f) {
  const a = f.appProperties ?? {};
  const at = Number(a.at) || Date.parse(f.createdTime ?? "") || 0;
  return {
    id: f.id,
    at,
    day: a.day ?? dayOf(at),
    deviceName: a.deviceName ?? "",
    books: Number(a.books) || 0,
    names: Number(a.names) || 0,
    reason: a.reason === "manual" || a.reason === "restore" || a.reason === "join" ? a.reason : "auto"
  };
}
var revisionName = (deviceName, books, names) => `dulieu - ${deviceName} - ${books} books, ${names} names.txt`;
var revisionId = (fileId, revId) => `rev:${fileId}:${revId}`;
function parseRevisionId(id) {
  const m = /^rev:([^:]+):(.+)$/.exec(id);
  return m ? { fileId: m[1], revId: m[2] } : undefined;
}
function versionFromRevision(fileId, r, current) {
  const at = Date.parse(r.modifiedTime ?? "") || 0;
  const m = /^dulieu - (.*) - (\d+) books, (\d+) names\.txt$/.exec(r.originalFilename ?? "");
  return {
    id: revisionId(fileId, r.id),
    at,
    day: dayOf(at),
    deviceName: m?.[1] ?? "",
    books: m ? Number(m[2]) : undefined,
    names: m ? Number(m[3]) : undefined,
    size: r.size === undefined ? undefined : Number(r.size),
    reason: "auto",
    current,
    temporary: !r.keepForever
  };
}
var byNewest = (a, b) => b.at - a.at;
function toRelease(versions) {
  return versions.filter((v) => v.id.startsWith("rev:") && !v.temporary).sort(byNewest).slice(KEEP_FOREVER).filter((v) => !v.current);
}

// src/shared/engine.ts
var FOLDER_NAME = "SangTacViet Sync";
var EXPORT_NAME = "dulieu.txt";
var TOMBSTONE_TTL = 180 * 24 * 3600 * 1000;
var MAX_ATTEMPTS = 5;
var COMPACT_AT = 30;
var OPS_MAX_ITEMS = 1000;

class DeviceRemovedError extends Error {
}
var tag = (k) => `appProperties has { key='stvSync' and value='${k}' }`;
var TAGGED = ["root", "device", "ops", "export"].map(tag).join(" or ");
var SYNC_LIST = `${TAGGED} or ${tag("backup")}`;
var VERSIONS_LIST = `trashed=false and (${tag("export")} or ${tag("backup")})`;
var kindOf = (f) => f.appProperties?.stvSync;
var deviceOf = (f) => f.appProperties?.device ?? "";
var seqOf = (f) => Number(f.appProperties?.seq ?? 0);
var oldestFirst = (a, b) => (a.createdTime ?? "").localeCompare(b.createdTime ?? "");
var toWire = (items, keys) => {
  const out = {};
  for (const k of keys) {
    const it = items[k];
    if (it)
      out[k] = [it.t, it.v];
  }
  return out;
};
var fromWire = (w) => Object.fromEntries(Object.entries(w).map(([k, [t, v]]) => [k, { t, v }]));
var isNotFound = (e) => e instanceof DriveError && e.status === 404;
async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

class SyncEngine {
  kv;
  drive;
  account;
  device;
  now;
  constructor(kv, drive, account, device, now = Date.now) {
    this.kv = kv;
    this.drive = drive;
    this.account = account;
    this.device = device;
    this.now = now;
  }
  get stateKey() {
    return `state:${this.account}`;
  }
  get remoteKey() {
    return `remote:${this.account}`;
  }
  get outboxKey() {
    return `outbox:${this.account}`;
  }
  shadowKey(origin) {
    return `shadow:${this.account}:${origin}`;
  }
  async load() {
    const state = await this.kv.get(this.stateKey) ?? { items: {}, rev: 0 };
    const remote = await this.kv.get(this.remoteKey) ?? { devices: [] };
    return [state, remote];
  }
  async sync(replica, times) {
    const [state, remote] = await this.load();
    const name = this.device.name;
    const result = (written) => ({
      written,
      pushed,
      counts: counts(state.items),
      device: this.device.name === name ? undefined : this.device
    });
    let pushed = false;
    let joinSaved = false;
    let files = [];
    const pull = async () => {
      const r = await this.pull(state, remote);
      files = r.files;
      return r.changed;
    };
    for (let attempt = 0;attempt < MAX_ATTEMPTS; attempt++) {
      const now = this.now();
      const read = replica ? await replica.read() : null;
      const shadow = replica && read?.marked ? await this.kv.get(this.shadowKey(replica.origin)) ?? null : null;
      const touched = new Set;
      let changed = false;
      if (attempt === 0 && !shadow)
        changed = await pull() || changed;
      if (read)
        changed = absorbLocal(state.items, read.snapshot, shadow, { now, times, stamp: read.stamp, touched }) || changed;
      if (attempt === 0 && shadow)
        changed = await pull() || changed;
      if (changed)
        changed = resolveTerms(state.items, touched) || changed;
      if (read && !shadow && !joinSaved)
        joinSaved = await this.saveJoin(read.snapshot, state.items, remote);
      changed = dropTombstones(state.items, now - TOMBSTONE_TTL) || changed;
      if (changed) {
        state.rev++;
        await this.kv.set(this.stateKey, state);
      }
      if (touched.size)
        await this.kv.set(this.outboxKey, [...new Set([...await this.outbox(), ...touched])]);
      pushed = await this.push(state, remote) || pushed;
      await this.kv.set(this.remoteKey, remote);
      if (!replica || !read) {
        await this.publish(state, remote, files);
        return result([]);
      }
      const plan = planWrites(read.snapshot, buildSnapshot(state.items, read.snapshot));
      if ((!isEmptyPlan(plan) || !read.marked) && !await replica.apply(plan))
        continue;
      await this.kv.set(this.shadowKey(replica.origin), applyPlan(read.snapshot, plan));
      if (!remote.origins?.includes(replica.origin)) {
        remote.origins = [...remote.origins ?? [], replica.origin];
        await this.kv.set(this.remoteKey, remote);
      }
      await this.publish(state, remote, files);
      return result(Object.keys(plan.set));
    }
    throw new Error("The page kept changing its data during sync; will retry.");
  }
  async outbox() {
    return await this.kv.get(this.outboxKey) ?? [];
  }
  async pull(state, remote) {
    const files = await this.drive.list(`trashed=false and (${SYNC_LIST})`);
    files.sort(oldestFirst);
    remote.folderId ??= files.find((f) => kindOf(f) === "root")?.id;
    remote.exportFileId ??= files.find((f) => kindOf(f) === "export")?.id;
    const bases = files.filter((f) => kindOf(f) === "device");
    const changes = files.filter((f) => kindOf(f) === "ops").sort((a, b) => seqOf(a) - seqOf(b));
    if (remote.deviceFileId && !bases.some((f) => f.id === remote.deviceFileId) && await this.removed(remote.deviceFileId))
      throw new DeviceRemovedError("This browser was removed from the account in another browser.");
    const own = bases.find((f) => deviceOf(f) === this.device.id && (!remote.deviceFileId || f.id === remote.deviceFileId));
    if (own) {
      remote.deviceFileId ??= own.id;
      remote.legacy = own.appProperties?.upTo === undefined;
      this.adoptName(own, remote);
    }
    const mine = changes.filter((f) => deviceOf(f) === this.device.id).map((f) => ({ id: f.id, seq: seqOf(f) }));
    const top = Math.max(0, ...mine.map((o) => o.seq));
    remote.ops = [...mine, ...(remote.ops ?? []).filter((o) => o.seq > top)];
    remote.seq = Math.max(remote.seq ?? 0, Number(own?.appProperties?.upTo ?? 0), top);
    let changed = false;
    const merge = (items) => {
      if (items)
        changed = mergeItems(state.items, fromWire(items)) || changed;
    };
    const merged = {};
    for (const f of bases) {
      if (f.id === remote.deviceFileId)
        continue;
      const prev = remote.merged?.[f.id];
      if (f.appProperties?.upTo === undefined) {
        const sum = f.md5Checksum ?? f.modifiedTime ?? "";
        if (!sum || prev?.sum !== sum)
          merge((await this.downloadJson(f.id, "stv-drive-sync/device"))?.items);
        merged[f.id] = { seq: 0, sum };
        continue;
      }
      const upTo = Number(f.appProperties.upTo);
      const theirs = changes.filter((c) => deviceOf(c) === deviceOf(f));
      const run = (from) => {
        const out = [];
        for (const c of theirs) {
          if (seqOf(c) <= from)
            continue;
          if (seqOf(c) > (out.length ? seqOf(out.at(-1)) : from) + 1)
            break;
          out.push(c);
        }
        return out;
      };
      let from = prev?.seq ?? -1;
      let next = run(from);
      if (upTo > (next.length ? seqOf(next.at(-1)) : from)) {
        merge((await this.downloadJson(f.id, "stv-drive-sync/device"))?.items);
        from = upTo;
        next = run(from);
      }
      const got = await Promise.all(next.map((c) => this.downloadJson(c.id, "stv-drive-sync/ops")));
      for (const [i, file] of got.entries()) {
        if (file === null)
          break;
        merge(file?.items);
        from = seqOf(next[i]);
      }
      merged[f.id] = { seq: from };
    }
    remote.merged = merged;
    remote.devices = this.devicesFrom(files);
    remote.versionIds = files.filter((f) => kindOf(f) === "backup" || kindOf(f) === "export").map((f) => kindOf(f) === "export" ? `${f.id}@${f.modifiedTime}` : f.id).sort().join(",");
    return { changed, files };
  }
  async downloadJson(id, format) {
    try {
      const file = JSON.parse(await this.drive.download(id));
      return file.format === format ? file : undefined;
    } catch (e) {
      if (isNotFound(e))
        return null;
      if (e instanceof SyntaxError)
        return;
      throw e;
    }
  }
  async removed(fileId) {
    try {
      return !!(await this.drive.get(fileId)).trashed;
    } catch (e) {
      if (isNotFound(e))
        return true;
      throw e;
    }
  }
  adoptName(f, remote) {
    const name = f.appProperties?.deviceName;
    const at = Number(f.appProperties?.deviceNameAt ?? 0);
    if (name && at > (this.device.nameAt ?? 0))
      this.device = { ...this.device, name, nameAt: at };
    else if (name !== this.device.name.slice(0, 60))
      remote.renamed = true;
  }
  devicesFrom(files) {
    const last = new Map;
    for (const f of files) {
      const kind = kindOf(f);
      if (kind !== "device" && kind !== "ops")
        continue;
      const t = f.modifiedTime ?? "";
      if (t > (last.get(deviceOf(f)) ?? ""))
        last.set(deviceOf(f), t);
    }
    return files.filter((f) => kindOf(f) === "device").map((f) => {
      const id = deviceOf(f);
      const self = id === this.device.id;
      return { id, name: self ? this.device.name : f.appProperties?.deviceName ?? id, updated: last.get(id) || f.modifiedTime, self };
    });
  }
  async push(state, remote, whole = false) {
    const outbox = await this.outbox();
    whole ||= !remote.deviceFileId || !!remote.legacy || outbox.length > OPS_MAX_ITEMS || (remote.ops?.length ?? 0) >= COMPACT_AT;
    if (!whole && !outbox.length) {
      if (remote.renamed && remote.deviceFileId) {
        await this.drive.patch(remote.deviceFileId, { appProperties: this.nameProps(this.device.name, this.device.nameAt ?? 0) });
        remote.renamed = false;
      }
      return false;
    }
    const folder = await this.ensureFolder(remote);
    const seq = (remote.seq ?? 0) + 1;
    if (whole) {
      const file = {
        format: "stv-drive-sync/device",
        v: 1,
        device: this.device,
        updated: this.now(),
        upTo: seq,
        items: toWire(state.items, Object.keys(state.items))
      };
      remote.deviceFileId = await this.upsert(remote.deviceFileId, JSON.stringify(file), "application/json", {
        name: `device-${this.device.id}.json`,
        parents: [folder],
        appProperties: { stvSync: "device", device: this.device.id, upTo: String(seq), ...this.nameProps(this.device.name, this.device.nameAt ?? 0) }
      });
      remote.legacy = remote.renamed = false;
      const folded = remote.ops ?? [];
      remote.ops = [];
      await Promise.all(folded.map((o) => this.removeIfThere(o.id).catch((e) => console.warn("Could not delete a change file.", e))));
    } else {
      const file = { format: "stv-drive-sync/ops", v: 1, device: this.device.id, seq, items: toWire(state.items, outbox) };
      const created = await this.drive.create({ name: `changes-${this.device.id}-${seq}.json`, parents: [folder], appProperties: { stvSync: "ops", device: this.device.id, seq: String(seq) } }, JSON.stringify(file), "application/json");
      remote.ops = [...remote.ops ?? [], { id: created.id, seq }];
    }
    remote.seq = seq;
    await this.kv.set(this.outboxKey, []);
    const self = { id: this.device.id, name: this.device.name, updated: new Date(this.now()).toISOString(), self: true };
    remote.devices = [...remote.devices.filter((d) => !d.self), self];
    return true;
  }
  async upsert(id, content, type, meta, opts) {
    if (id) {
      try {
        const { name: _n, ...rest } = meta;
        return (await this.drive.update(id, content, type, rest, opts)).id;
      } catch (e) {
        if (!isNotFound(e))
          throw e;
      }
    }
    return (await this.drive.create(meta, content, type, opts)).id;
  }
  async ensureFolder(remote) {
    if (remote.folderId)
      return remote.folderId;
    const existing = await this.drive.byKind("root");
    remote.folderId = existing[0]?.id ?? (await this.drive.createFolder({ name: FOLDER_NAME, appProperties: { stvSync: "root" } })).id;
    return remote.folderId;
  }
  nameProps(name, at) {
    return { deviceName: name.slice(0, 60), deviceNameAt: String(at) };
  }
  async publish(state, remote, files) {
    if (remote.publishedRev === state.rev && remote.exportHash)
      return;
    const c = counts(state.items);
    if (!c.books && !c.names)
      return;
    try {
      if (await this.writeExport(state, remote, files))
        await this.rotate(files, remote);
      remote.publishedRev = state.rev;
    } catch (e) {
      console.warn("Could not update dulieu.txt or its versions; the next sync tries again.", e);
    }
    await this.kv.set(this.remoteKey, remote);
  }
  async writeExport(state, remote, files) {
    const text = exportText(state.items);
    const hash = await sha256(text);
    const exp = files.find((f) => kindOf(f) === "export" && f.id === remote.exportFileId);
    const uploaded = exp?.appProperties?.hash !== hash;
    if (uploaded) {
      const c = counts(state.items);
      remote.exportFileId = await this.upsert(remote.exportFileId, text, "text/plain", {
        name: EXPORT_NAME,
        parents: [await this.ensureFolder(remote)],
        appProperties: { stvSync: "export", hash },
        originalFilename: revisionName(this.device.name.slice(0, 60), c.books, c.names)
      }, { keepForever: true });
    }
    remote.exportHash = hash;
    return uploaded;
  }
  async summary() {
    const files = await this.drive.list(`trashed=false and (${TAGGED})`);
    const devices = this.devicesFrom(files);
    const exp = files.find((f) => kindOf(f) === "export");
    return { exists: devices.length > 0 || !!exp, devices, exportUpdated: exp?.modifiedTime };
  }
  deviceFiles(id, kinds = ["device", "ops"]) {
    return this.drive.list(`trashed=false and (${kinds.map(tag).join(" or ")}) and appProperties has { key='device' and value=${quote(id)} }`);
  }
  async listDevices() {
    const devices = this.devicesFrom(await this.drive.list(`trashed=false and (${tag("device")} or ${tag("ops")})`));
    await this.updateCache((remote) => remote.devices = devices);
    return devices;
  }
  async renameDevice(id, name, at) {
    if (id === this.device.id)
      this.device = { ...this.device, name, nameAt: at };
    for (const f of await this.deviceFiles(id, ["device"]))
      await this.drive.patch(f.id, { appProperties: this.nameProps(name, at) });
    await this.updateCache((remote) => remote.devices = remote.devices.map((d) => d.id === id ? { ...d, name } : d));
  }
  async removeDevice(id) {
    await Promise.all((await this.deviceFiles(id)).map((f) => this.drive.patch(f.id, { trashed: true })));
    if (id === this.device.id)
      return this.forget();
    await this.updateCache((remote) => remote.devices = remote.devices.filter((d) => d.id !== id));
  }
  async updateCache(fn) {
    const remote = await this.kv.get(this.remoteKey);
    if (!remote)
      return;
    fn(remote);
    await this.kv.set(this.remoteKey, remote);
  }
  async versions() {
    const files = (await this.drive.list(VERSIONS_LIST)).sort(oldestFirst);
    const exp = files.find((f) => kindOf(f) === "export");
    return { versions: await this.versionList(files, exp?.id) };
  }
  async versionList(files, exportId) {
    const out = files.filter((f) => kindOf(f) === "backup").map(versionFrom);
    if (exportId) {
      try {
        const revisions = await this.drive.revisions(exportId);
        const head = revisions.at(-1)?.id;
        out.push(...revisions.map((r) => versionFromRevision(exportId, r, r.id === head)));
      } catch (e) {
        if (!isNotFound(e))
          throw e;
      }
    }
    return out.sort(byNewest);
  }
  async joinFileMeta(items, remote, reason) {
    const at = this.now();
    const c = counts(items);
    const day = dayOf(at);
    return {
      name: `dulieu before joining - ${this.device.name.slice(0, 60)} - ${day} ${new Date(at).toTimeString().slice(0, 8).replaceAll(":", "")}.txt`,
      parents: [await this.ensureFolder(remote)],
      appProperties: {
        stvSync: "backup",
        at: String(at),
        day,
        deviceName: this.device.name.slice(0, 60),
        books: String(c.books),
        names: String(c.names),
        reason
      }
    };
  }
  async saveJoin(page, items, remote) {
    const own = liveItems(page).values;
    if (![...own].some(([k, v]) => items[k]?.v !== v))
      return true;
    try {
      const pageItems = Object.fromEntries([...own].map(([k, v]) => [k, { t: 0, v }]));
      await this.drive.create(await this.joinFileMeta(pageItems, remote, "join"), JSON.stringify(toExport(page)), "text/plain");
      return true;
    } catch (e) {
      console.warn("Could not save this browser's data before joining.", e);
      return false;
    }
  }
  async rotate(files, remote) {
    const versions = await this.versionList(files, remote.exportFileId);
    const head = versions.find((v) => v.current && v.temporary);
    const rev = head && parseRevisionId(head.id);
    if (rev) {
      await this.drive.keepRevision(rev.fileId, rev.revId, true);
      head.temporary = false;
    }
    await Promise.all(toRelease(versions).map((v) => {
      const r = parseRevisionId(v.id);
      return this.drive.keepRevision(r.fileId, r.revId, false).catch((e) => isNotFound(e) ? undefined : Promise.reject(e));
    }));
  }
  removeVersion(id) {
    const rev = parseRevisionId(id);
    return rev ? this.drive.removeRevision(rev.fileId, rev.revId) : this.drive.remove(id);
  }
  async removeIfThere(id) {
    try {
      await this.drive.remove(id);
    } catch (e) {
      if (!isNotFound(e))
        throw e;
    }
  }
  async versionFiles(remote) {
    const files = (await this.drive.list(VERSIONS_LIST)).sort(oldestFirst);
    remote.exportFileId ??= files.find((f) => kindOf(f) === "export")?.id;
    return files;
  }
  async saveVersion() {
    const [state, remote] = await this.load();
    const files = await this.versionFiles(remote);
    if (await this.writeExport(state, remote, files))
      await this.rotate(files, remote);
    await this.updateCache((r) => Object.assign(r, { exportHash: remote.exportHash, exportFileId: remote.exportFileId, folderId: remote.folderId }));
  }
  async deleteVersion(id) {
    const rev = parseRevisionId(id);
    if (rev && (await this.drive.revisions(rev.fileId)).at(-1)?.id === rev.revId)
      throw new Error("The latest version is dulieu.txt's current content; it can't be deleted.");
    try {
      await this.removeVersion(id);
    } catch (e) {
      if (!rev || !(e instanceof DriveError) || e.status === 404)
        throw e;
      await this.drive.keepRevision(rev.fileId, rev.revId, true);
      await this.removeVersion(id);
    }
  }
  async downloadVersion(id) {
    const rev = parseRevisionId(id);
    if (!rev)
      return this.drive.download(id);
    try {
      return await this.drive.downloadRevision(rev.fileId, rev.revId);
    } catch (e) {
      if (!(e instanceof DriveError) || e.status === 404)
        throw e;
      await this.drive.keepRevision(rev.fileId, rev.revId, true);
      try {
        return await this.drive.downloadRevision(rev.fileId, rev.revId);
      } finally {
        await this.drive.keepRevision(rev.fileId, rev.revId, false).catch(() => {
          return;
        });
      }
    }
  }
  async restoreVersion(id) {
    const file = JSON.parse(await this.downloadVersion(id));
    if (!file || typeof file !== "object" || typeof file.name !== "object")
      throw new Error("That file is not a version of the data.");
    const [state, remote] = await this.load();
    const files = await this.versionFiles(remote);
    await this.writeExport(state, remote, files);
    replaceWith(state.items, fromExport({ name: file.name, tusach: file.tusach }), this.now());
    resolveTerms(state.items);
    state.rev++;
    await this.kv.set(this.stateKey, state);
    await this.push(state, remote, true);
    await this.writeExport(state, remote, []);
    remote.publishedRev = state.rev;
    await this.kv.set(this.remoteKey, remote);
    await this.rotate(files, remote);
  }
  async exportText() {
    const [state] = await this.load();
    return exportText(state.items);
  }
  async stats() {
    const [state] = await this.load();
    return counts(state.items);
  }
  async forget() {
    const [, remote] = await this.load();
    for (const o of remote.origins ?? [])
      await this.kv.remove(this.shadowKey(o));
    await this.kv.remove(this.stateKey);
    await this.kv.remove(this.remoteKey);
    await this.kv.remove(this.outboxKey);
  }
}
function exportText(items) {
  return JSON.stringify(toExport(buildSnapshot(items, EMPTY)));
}

// src/background/sync.ts
function engineFor(s, sub) {
  const account = s.accounts.find((a) => a.sub === sub);
  if (!account)
    throw new Error("Unknown account");
  const drive = new Drive((stale) => tokenFor(account, stale), s.driveBase || DRIVE_BASE);
  return new SyncEngine(local, drive, sub, s.device);
}
var timesKey = (origin) => `times:${origin}`;
async function recordWrite(origin, key, t) {
  const k = timesKey(origin);
  const times = (await chrome.storage.session.get(k))[k] ?? {};
  times[key] = Math.max(times[key] ?? 0, t);
  await chrome.storage.session.set({ [k]: times });
}
async function send(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
}
async function openTabs(domains) {
  const byOrigin = new Map;
  const tabs = await chrome.tabs.query({ url: domainPatterns(domains) });
  for (const t of tabs) {
    if (t.id == null || !matchesDomain(t.url, domains) || t.discarded)
      continue;
    const origin = new URL(t.url).origin;
    if (!byOrigin.has(origin) || t.active)
      byOrigin.set(origin, t.id);
  }
  return byOrigin;
}
function tabReplica(origin, tabId, hosts) {
  return {
    origin,
    read: () => send(tabId, { type: "read", hosts }),
    async apply(plan) {
      const r = await send(tabId, { type: "apply", plan });
      if (r.error)
        throw new Error(`Could not write to ${origin}: ${r.error}`);
      return r.ok;
    }
  };
}
var syncing = false;
var isSyncing = () => syncing;
var chain = Promise.resolve();
var pending = new Map;
var timer;
function schedule(origin, tabId, delay = 1500) {
  pending.set(origin ?? "*", tabId);
  clearTimeout(timer);
  timer = setTimeout(() => void run(), delay);
}
function syncAllNow() {
  pending.set("*", undefined);
  clearTimeout(timer);
  return run();
}
function serialized(fn) {
  const p = chain.then(fn);
  chain = p.then(() => {}, () => {});
  return p;
}
async function detach(s, sub, notice) {
  await engineFor(s, sub).forget();
  await updateSettings((cur) => ({ linked: { ...cur.linked, [sub]: false } }));
  await setAccountStatus(sub, { lastError: undefined, notice });
}
function run() {
  const jobs = new Map(pending);
  pending.clear();
  chain = chain.then(() => runJobs(jobs)).catch((e) => console.error(e));
  return chain;
}
async function runJobs(jobs) {
  if (jobs.size === 0)
    return;
  const s = await getSettings();
  const sub = s.active;
  if (!sub || !s.linked[sub])
    return;
  const engine = engineFor(s, sub);
  const tabs = await openTabs(s.domains);
  const targets = jobs.has("*") ? new Map(tabs) : new Map;
  for (const [origin, tabId] of jobs) {
    if (origin === "*")
      continue;
    const id = tabs.get(origin) ?? tabId;
    if (id != null)
      targets.set(origin, id);
  }
  syncing = true;
  await chrome.runtime.sendMessage({ type: "changed" }).catch(() => {});
  try {
    const adopt = async (r) => r.device && await local.set("device", r.device);
    if (targets.size === 0)
      await adopt(await engine.sync());
    for (const [origin, tabId] of targets) {
      const started = Date.now();
      const k = timesKey(origin);
      const times = (await chrome.storage.session.get(k))[k] ?? {};
      try {
        await adopt(await engine.sync(tabReplica(origin, tabId, s.hosts), times));
      } catch (e) {
        if (/Receiving end does not exist|No tab with id|message port closed/i.test(String(e)))
          continue;
        throw e;
      }
      const left = Object.fromEntries(Object.entries(times).filter(([, t]) => t > started));
      await chrome.storage.session.set({ [k]: left });
    }
    await setAccountStatus(sub, { lastSync: Date.now(), lastError: undefined });
    await chrome.alarms.clear("retry");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof DeviceRemovedError) {
      await detach(s, sub, message);
    } else {
      await setAccountStatus(sub, { lastError: message });
      if (!(e instanceof AuthError))
        await chrome.alarms.create("retry", { delayInMinutes: 1 });
    }
  } finally {
    syncing = false;
    await updateBadge();
    await chrome.runtime.sendMessage({ type: "changed" }).catch(() => {});
  }
}
async function updateBadge() {
  const s = await getSettings();
  const st = s.active ? await local.get(`status:${s.active}`) ?? {} : {};
  const bad = !!s.active && s.linked[s.active] && (st.needsAuth || !!st.lastError);
  await chrome.action.setBadgeText({ text: bad ? "!" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
}
async function openTabCount() {
  return (await openTabs((await getSettings()).domains)).size;
}

// src/background/main.ts
var PERIOD_MIN = 5;
chrome.runtime.onInstalled.addListener(() => void setup());
chrome.runtime.onStartup.addListener(() => void setup());
async function setup() {
  await getSettings();
  await registerContentScripts();
  await chrome.alarms.create("pull", { periodInMinutes: PERIOD_MIN });
  await updateBadge();
  schedule(undefined, undefined, 3000);
}
chrome.alarms.onAlarm.addListener(() => schedule(undefined, undefined, 0));
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!sender.url?.startsWith(chrome.runtime.getURL(""))) {
    fromPage(msg, sender);
    return false;
  }
  handleUi(msg).then((value) => reply({ ok: true, value }), (e) => reply({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return true;
});
async function fromPage(msg, sender) {
  if (sender.frameId !== 0 || !sender.tab?.id)
    return;
  const s = await getSettings();
  if (!matchesDomain(sender.url, s.domains))
    return;
  const origin = new URL(sender.url).origin;
  if (msg.type === "hosts") {
    const extra = msg.hosts.filter((h) => typeof h === "string" && h && !s.hosts.includes(h));
    if (extra.length)
      await updateSettings((cur) => ({ hosts: [...cur.hosts, ...extra] }));
    return;
  }
  if (!s.active || !s.linked[s.active])
    return;
  if (msg.type === "dirty") {
    await recordWrite(origin, msg.key, msg.t);
    schedule(origin, sender.tab.id, 2000);
  } else if (msg.type === "hello") {
    schedule(origin, sender.tab.id, 500);
  }
}
async function handleUi(msg) {
  const s = await getSettings();
  const active = s.active;
  switch (msg.type) {
    case "status":
      return status();
    case "summary":
      if (!active)
        throw new Error("No account selected");
      return engineFor(s, active).summary();
    case "addAccount": {
      const a = await addAccount();
      await updateBadge();
      return a;
    }
    case "reconnect": {
      const a = s.accounts.find((x) => x.sub === msg.sub);
      if (!a)
        throw new Error("Unknown account");
      await reconnect(a);
      schedule();
      return null;
    }
    case "removeAccount": {
      if (s.accounts.some((a) => a.sub === msg.sub))
        await engineFor(s, msg.sub).forget();
      await signOut(msg.sub);
      await local.remove(`status:${msg.sub}`);
      await updateSettings((cur) => {
        const accounts = cur.accounts.filter((a) => a.sub !== msg.sub);
        const { [msg.sub]: _gone, ...linked } = cur.linked;
        return { accounts, linked, active: cur.active === msg.sub ? accounts[0]?.sub : cur.active };
      });
      await updateBadge();
      return null;
    }
    case "setActive":
      await updateSettings(() => ({ active: msg.sub }));
      await updateBadge();
      schedule(undefined, undefined, 0);
      return null;
    case "link":
      if (!active)
        throw new Error("No account selected");
      await setAccountStatus(active, { notice: undefined });
      await updateSettings((cur) => ({ linked: { ...cur.linked, [active]: true } }));
      await syncAllNow();
      return status();
    case "unlink":
      if (!active)
        throw new Error("No account selected");
      await updateSettings((cur) => ({ linked: { ...cur.linked, [active]: false } }));
      await setAccountStatus(active, { lastError: undefined });
      await updateBadge();
      return null;
    case "syncNow":
      await syncAllNow();
      return status();
    case "export":
      if (!active)
        throw new Error("No account selected");
      return engineFor(s, active).exportText();
    case "devices":
      return active ? serialized(() => engineFor(s, active).listDevices()) : [];
    case "renameDevice": {
      const name = msg.name.trim().slice(0, 60);
      if (!name)
        throw new Error("Enter a name");
      const at = Date.now();
      if (msg.id === s.device.id)
        await local.set("device", { ...s.device, name, nameAt: at });
      else if (!active)
        throw new Error("No account selected");
      if (active)
        await serialized(() => engineFor(s, active).renameDevice(msg.id, name, at));
      await changed();
      return null;
    }
    case "removeDevice":
      if (!active)
        throw new Error("No account selected");
      await serialized(() => engineFor(s, active).removeDevice(msg.id));
      if (msg.id === s.device.id)
        await detach(s, active);
      await updateBadge();
      await changed();
      return null;
    case "versions":
      if (!active)
        throw new Error("No account selected");
      return serialized(() => engineFor(s, active).versions());
    case "saveVersion":
      return serialized(() => linkedEngine(s).saveVersion());
    case "deleteVersion":
      if (!active)
        throw new Error("No account selected");
      return serialized(() => engineFor(s, active).deleteVersion(msg.id));
    case "downloadVersion":
      if (!active)
        throw new Error("No account selected");
      return engineFor(s, active).downloadVersion(msg.id);
    case "restoreVersion":
      await serialized(() => linkedEngine(s).restoreVersion(msg.id));
      await syncAllNow();
      await changed();
      return null;
    case "settingsChanged":
      await registerContentScripts();
      schedule();
      return null;
  }
}
async function status() {
  const s = await getSettings();
  const accounts = await Promise.all(s.accounts.map(async (a) => ({ ...a, needsAuth: !!(await getAccountStatus(a.sub)).needsAuth, linked: !!s.linked[a.sub] })));
  const st = s.active ? await getAccountStatus(s.active) : {};
  const remote = s.active ? await local.get(`remote:${s.active}`) : undefined;
  return {
    device: s.device,
    domains: s.domains,
    accounts,
    active: s.active,
    syncing: isSyncing(),
    lastSync: st.lastSync,
    lastError: st.lastError,
    notice: st.notice,
    counts: s.active ? await engineFor(s, s.active).stats() : undefined,
    devices: remote?.devices ?? [],
    openTabs: await openTabCount()
  };
}
async function changed() {
  await chrome.runtime.sendMessage({ type: "changed" }).catch(() => {});
}
function linkedEngine(s) {
  if (!s.active)
    throw new Error("No account selected");
  if (!s.linked[s.active])
    throw new Error("Start syncing this account first.");
  return engineFor(s, s.active);
}
