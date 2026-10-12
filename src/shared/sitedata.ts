/**
 * What SangTacViet keeps as "personal data" — the same set its own
 * "Tải xuống lịch sử đọc và name" button exports (stv.ui.js exportTusach):
 *
 *   localStorage.tusach        reading history: JSON entries joined by "~/~", most recent first
 *   localStorage.<host><book>  names of one book: lines ("$中文=Việt") joined by "~//~"
 *
 * The site picks name keys with /^(<hostnames of window.hmeta>)\d+/i. "dich"
 * (translated books) and "qtOnline0" (the "one name list for all books"
 * setting) are names too, but the site's export misses them; we keep them.
 */

export interface Snapshot {
  tusach: string | null;
  names: Record<string, string>;
}

/** The site's export file: `{"name":{...},"tusach":"..."}`, importable with "Nhập lịch sử đọc và name". */
export interface ExportFile {
  name: Record<string, string>;
  tusach?: string;
}

export const TUSACH_KEY = "tusach";
/** Written into the page's localStorage by the extension. Missing after a sync means the storage was cleared since. */
export const MARK_KEY = "stv-drive-sync";
export const ENTRY_SEP = "~/~";
export const LINE_SEP = "~//~";
export const EXTRA_NAME_KEYS = ["qtOnline0"];

/** Object.keys(window.hmeta) from stv.host.js (2026-10), plus "dich". Pages refresh it at runtime. */
export const DEFAULT_HOSTS = [
  "uukanshu", "69shu", "69shuorg", "shu008", "xinyushuwu", "xiaoqiangwx", "cuiweijux", "-aikanshu",
  "-kygnew", "-aikanshuba", "biquge", "trxs", "ikshu8", "shulinw", "wuxia1", "xslou", "shu03", "shu05",
  "kuhu168", "2kxs", "shukw", "cn8118", "yikanxiaoshuo", "xiaoshuowa", "zwduxs", "8zwdu", "kanmaoxian",
  "kayegenet", "4gxsw", "qinqinxsw", "read8", "ciweimao", "wkkshu", "168kanshu", "wanbentxt", "38kanshu",
  "duanqingsi", "faloo", "qiuxiaoshuo", "dibaqu123", "jiacuan", "lsjxs2", "shubaow", "biqugeinfo",
  "shumilou", "xbiquge", "paoshu8", "duokan8", "biqugecom", "hetushu", "nofff", "uuxs", "ranwenla", "66wx",
  "biqugexs", "230book", "shumiloutw", "biqubu", "521danmei", "bxwxorg", "qidian", "zwdu", "xingeweb",
  "zongheng", "biqugese", "qiushubang", "xinshuhaige", "oldtimescc", "sinodan", "wuwuxs", "hs313",
  "shuchong", "shucw", "shumizu", "tadu", "ptwxz", "x81zw", "linovel", "wenku8", "youyoukanshu", "biqubao",
  "biqugele", "biqugebz", "biquge5200", "sfacg", "shubao45", "kujiang", "yushubo", "xklxsw", "fanqie",
  "xsbiquge", "kanman", "acqq", "cocomanga", "colamanga", "jjwxc", "kankeo", "qimao", "ddxs", "quanben5",
  "idejian", "dich",
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function nameKeyMatcher(hosts: Iterable<string>): (key: string) => boolean {
  const alt = [...new Set([...DEFAULT_HOSTS, ...hosts])].filter(Boolean).map(escapeRe).join("|");
  const re = new RegExp(`^(?:${alt})\\d+`, "i");
  return (key) => EXTRA_NAME_KEYS.includes(key) || re.test(key);
}

export function isDataKey(key: string, isName: (k: string) => boolean): boolean {
  return key === TUSACH_KEY || isName(key);
}

export function splitEntries(tusach: string | null): string[] {
  return tusach ? tusach.split(ENTRY_SEP).filter((e) => e !== "") : [];
}

/** Name lines without blanks, as the site's textarea would show them. */
export function splitLines(value: string | null | undefined): string[] {
  return value ? value.split(LINE_SEP).filter((l) => l.trim() !== "") : [];
}

/** saveNS() writes the textarea split on "\n" and joined with "~//~"; a trailing newline leaves a trailing separator. */
export function joinLines(lines: string[]): string {
  return lines.length ? lines.join(LINE_SEP) + LINE_SEP : "";
}

export interface TusachEntry {
  host: string;
  id: string;
  name?: string;
  current?: string;
}

export function parseEntry(entry: string): TusachEntry | null {
  try {
    const e = JSON.parse(entry) as Partial<TusachEntry>;
    return e && typeof e === "object" && e.host != null && e.id != null ? (e as TusachEntry) : null;
  } catch {
    return null;
  }
}

/** First number in the chapter title (the site's getChapterOrder); 0 when unknown. */
export function chapterOrder(entry: string): number {
  const current = parseEntry(entry)?.current ?? "";
  const title = current.split("-,-")[1] ?? "";
  const m = /\d+/.exec(title);
  return m ? Number(m[0]) : 0;
}

export function toExport(s: Snapshot): ExportFile {
  const out: ExportFile = { name: { ...s.names } };
  if (s.tusach) out.tusach = s.tusach;
  return out;
}

export function fromExport(f: ExportFile): Snapshot {
  return { tusach: f.tusach ?? null, names: { ...(f.name ?? {}) } };
}
