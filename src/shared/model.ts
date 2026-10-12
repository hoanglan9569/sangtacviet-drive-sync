/**
 * Sync model: the personal data as a last-writer-wins element set (a CRDT).
 *
 * Items are the smallest things two browsers can change independently:
 *   "t\x1f<host>-<id>"           one book in the reading history; value = its JSON entry
 *   "n\x1f<nameKey>\x1f<line>"   one name line of one book; value = ""
 * Each item carries the time it last changed, and deletions stay as tombstones
 * (v = null), so merging any two states in any order converges, a stale
 * browser can never overwrite a newer change, and two browsers adding names to
 * the same book keep both.
 */
import {
  type Snapshot,
  ENTRY_SEP,
  chapterOrder,
  joinLines,
  parseEntry,
  splitEntries,
  splitLines,
} from "./sitedata";

export interface Item {
  t: number;
  v: string | null;
}
export type Items = Record<string, Item>;

const T = "t\u001f";
const N = "n\u001f";
const SEP = "\u001f";

export const isEntryKey = (k: string) => k.startsWith(T);

export function entryKey(entry: string): string {
  const e = parseEntry(entry);
  return e ? `${T}${e.host}-${e.id}` : `${T}?${entry}`;
}

export const lineKey = (nameKey: string, line: string) => `${N}${nameKey}${SEP}${line}`;

export function splitLineKey(k: string): [nameKey: string, line: string] {
  const i = k.indexOf(SEP, N.length);
  return [k.slice(N.length, i), k.slice(i + 1)];
}

interface Live {
  values: Map<string, string>;
  /** Reading-history item keys, most recent first. */
  order: string[];
}

export function liveItems(s: Snapshot): Live {
  const values = new Map<string, string>();
  const order: string[] = [];
  for (const e of splitEntries(s.tusach)) {
    const k = entryKey(e);
    if (values.has(k)) continue;
    values.set(k, e);
    order.push(k);
  }
  for (const [nk, v] of Object.entries(s.names)) for (const line of splitLines(v)) values.set(lineKey(nk, line), "");
  return { values, order };
}

const cmpValue = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1);

/** Total order on versions of one item: later time wins, ties broken by value so every replica agrees. */
export function wins(inc: Item, cur: Item | undefined): boolean {
  if (!cur) return true;
  if (inc.t !== cur.t) return inc.t > cur.t;
  return cmpValue(inc.v, cur.v) > 0;
}

export function mergeItems(into: Items, from: Items): boolean {
  let changed = false;
  for (const [k, inc] of Object.entries(from)) {
    if (wins(inc, into[k])) {
      into[k] = { t: inc.t, v: inc.v };
      changed = true;
    }
  }
  return changed;
}

export interface AbsorbOptions {
  now: number;
  /** When the page wrote each localStorage key (from the storage hook). */
  times?: Record<string, number>;
  /** Reading-history timestamp of this browser (the site's `hstamp` cookie, ms), for first syncs. */
  stamp?: number;
}

/**
 * Records what changed in a browser's localStorage since `shadow` (what it held
 * after its last sync) into `items`. Without a shadow (first sync of this
 * browser) nothing is known to be deleted: everything local is merged in.
 */
export function absorbLocal(items: Items, local: Snapshot, shadow: Snapshot | null, o: AbsorbOptions): boolean {
  const L = liveItems(local);
  let changed = false;
  const put = (k: string, it: Item) => {
    if (!wins(it, items[k])) return;
    items[k] = it;
    changed = true;
  };
  const timeOf = (k: string) => Math.min(o.now, o.times?.[isEntryKey(k) ? "tusach" : splitLineKey(k)[0]] ?? o.now);

  if (!shadow) {
    const base = Math.min(o.now, o.stamp ?? o.now);
    const rank = new Map(L.order.map((k, i) => [k, i]));
    for (const [k, v] of L.values) {
      const t = base - (rank.get(k) ?? L.order.length);
      const cur = items[k];
      if (!cur) put(k, { t, v });
      // Never-synced browser: keep its data even if another browser deleted it.
      else if (cur.v === null) put(k, { t: Math.max(t, cur.t + 1), v });
      // Same book read on both: the further chapter wins.
      else if (cur.v !== v && chapterOrder(v) > chapterOrder(cur.v)) put(k, { t: Math.max(t, cur.t + 1), v });
    }
    return changed;
  }

  const S = liveItems(shadow);
  // One write time covers the whole history string, so books changed in the
  // same batch are spaced by their position to keep the page's order.
  const rank = new Map(L.order.map((k, i) => [k, i]));
  // A change made on top of the state's current value is causally newer than it,
  // whatever the clocks say; one made on top of something else is concurrent and goes by time.
  const stamped = (k: string, v: string | null): Item => {
    const cur = items[k];
    const t = timeOf(k) - (rank.get(k) ?? 0);
    return cur && S.values.get(k) === cur.v ? { t: Math.max(t, cur.t + 1), v } : { t, v };
  };
  for (const [k, v] of L.values) {
    if (S.values.get(k) === v || items[k]?.v === v) continue;
    put(k, stamped(k, v));
  }
  for (const k of S.values.keys()) {
    if (L.values.has(k) || items[k]?.v == null) continue;
    put(k, stamped(k, null));
  }
  // Re-reading a book moves its entry to the front without changing it
  // (deleting the front entry also changes the front, but not by a read).
  const first = L.order[0];
  const prevFirst = S.order[0];
  if (first && prevFirst && first !== prevFirst && L.values.has(prevFirst) && items[first]?.v === L.values.get(first)) {
    const cur = items[first]!;
    put(first, { t: Math.max(timeOf(first), cur.t + 1), v: cur.v });
  }
  return changed;
}

/**
 * The localStorage contents the items describe, written as close to `base`
 * (the browser's current data) as possible: name lists keep their order and
 * exact string when their lines did not change.
 */
export function buildSnapshot(items: Items, base: Snapshot): Snapshot {
  const entries: [string, Item][] = [];
  const lines = new Map<string, [string, number][]>();
  for (const [k, it] of Object.entries(items)) {
    if (it.v === null) continue;
    if (isEntryKey(k)) entries.push([k, it]);
    else {
      const [nk, line] = splitLineKey(k);
      let l = lines.get(nk);
      if (!l) lines.set(nk, (l = []));
      l.push([line, it.t]);
    }
  }
  entries.sort(([ka, a], [kb, b]) => b.t - a.t || (ka < kb ? -1 : ka > kb ? 1 : 0));
  const tusach = entries.length ? entries.map(([, it]) => it.v).join(ENTRY_SEP) : base.tusach === null ? null : "";

  const names: Record<string, string> = {};
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

function sameSet(lines: string[], set: Set<string>): boolean {
  const s = new Set(lines);
  if (s.size !== set.size) return false;
  for (const l of s) if (!set.has(l)) return false;
  return true;
}

export interface WritePlan {
  /** Current values the page must still hold for the write to go ahead. */
  expect: Record<string, string | null>;
  set: Record<string, string | null>;
}

export function planWrites(local: Snapshot, desired: Snapshot): WritePlan {
  const plan: WritePlan = { expect: {}, set: {} };
  const a = splitEntries(local.tusach);
  const b = splitEntries(desired.tusach);
  if (a.length !== b.length || a.some((e, i) => e !== b[i])) {
    plan.expect.tusach = local.tusach;
    plan.set.tusach = desired.tusach;
  }
  for (const [nk, v] of Object.entries(desired.names)) {
    const cur = local.names[nk] ?? null;
    if (cur === v || sameSet(splitLines(cur), new Set(splitLines(v)))) continue;
    plan.expect[nk] = cur;
    plan.set[nk] = v;
  }
  return plan;
}

export const isEmptyPlan = (p: WritePlan) => Object.keys(p.set).length === 0;

export function applyPlan(s: Snapshot, p: WritePlan): Snapshot {
  const out: Snapshot = { tusach: s.tusach, names: { ...s.names } };
  for (const [k, v] of Object.entries(p.set)) {
    if (k === "tusach") out.tusach = v;
    else if (v === null) delete out.names[k];
    else out.names[k] = v;
  }
  return out;
}

/** Drops tombstones older than `before`; a browser offline for longer may bring those items back. */
export function dropTombstones(items: Items, before: number): boolean {
  let changed = false;
  for (const [k, it] of Object.entries(items)) {
    if (it.v === null && it.t < before) {
      delete items[k];
      changed = true;
    }
  }
  return changed;
}

export function counts(items: Items): { books: number; nameLists: number; names: number } {
  let books = 0;
  let names = 0;
  const lists = new Set<string>();
  for (const [k, it] of Object.entries(items)) {
    if (it.v === null) continue;
    if (isEntryKey(k)) books++;
    else {
      names++;
      lists.add(splitLineKey(k)[0]);
    }
  }
  return { books, nameLists: lists.size, names };
}

export const EMPTY: Snapshot = { tusach: null, names: {} };
