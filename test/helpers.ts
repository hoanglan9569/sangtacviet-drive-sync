import { Drive } from "../src/shared/drive";
import { type KV, type Replica, SyncEngine } from "../src/shared/engine";
import type { WritePlan } from "../src/shared/model";
import { type Snapshot, nameKeyMatcher } from "../src/shared/sitedata";
import type { FakeDrive } from "./fake-drive";

export function memoryKV(): KV & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(k: string) {
      const v = data.get(k);
      return v === undefined ? undefined : (structuredClone(v) as T);
    },
    async set(k, v) {
      data.set(k, structuredClone(v));
    },
    async remove(k) {
      data.delete(k);
    },
  };
}

/** One sangtacviet origin's localStorage, read and written the way the content script does. */
export class FakePage implements Replica {
  readonly ls = new Map<string, string>();
  /** Write time per key, as the storage hook reports it. */
  readonly times: Record<string, number> = {};
  /** Runs between read() and apply(), to simulate the page writing mid-sync. */
  beforeApply?: () => void;
  private readonly isName = nameKeyMatcher([]);

  constructor(
    readonly origin = "https://sangtacviet.com",
    private readonly clock?: Clock,
  ) {}

  private write(k: string, v: string): void {
    this.ls.set(k, v);
    if (this.clock) this.times[k] = this.clock.now();
  }

  async read(): Promise<{ snapshot: Snapshot }> {
    const names: Record<string, string> = {};
    for (const [k, v] of this.ls) if (this.isName(k)) names[k] = v;
    return { snapshot: { tusach: this.ls.get("tusach") ?? null, names } };
  }

  async apply(plan: WritePlan): Promise<boolean> {
    this.beforeApply?.();
    this.beforeApply = undefined;
    for (const [k, v] of Object.entries(plan.expect)) if ((this.ls.get(k) ?? null) !== v) return false;
    for (const [k, v] of Object.entries(plan.set)) v === null ? this.ls.delete(k) : this.ls.set(k, v);
    return true;
  }

  /** What the site's updateTusach does when a chapter is opened. */
  read_(host: string, id: string, chap: number): void {
    const e = entry(host, id, chap);
    const rest = (this.ls.get("tusach") ?? "").split("~/~").filter((x) => x && !x.includes(`"id":"${id}"`));
    this.write("tusach", [e, ...rest].join("~/~"));
  }

  addName(key: string, line: string): void {
    const lines = (this.ls.get(key) ?? "").split("~//~").filter(Boolean);
    this.write(key, [...lines, line].join("~//~") + "~//~");
  }

  removeName(key: string, line: string): void {
    const lines = (this.ls.get(key) ?? "").split("~//~").filter((l) => l && l !== line);
    this.write(key, lines.join("~//~") + "~//~");
  }

  books(): string[] {
    return (this.ls.get("tusach") ?? "")
      .split("~/~")
      .filter(Boolean)
      .map((e) => {
        const j = JSON.parse(e) as { id: string; current: string };
        return `${j.id}@${j.current.split("-,-")[0]}`;
      });
  }

  names(key: string): string[] {
    return (this.ls.get(key) ?? "").split("~//~").filter(Boolean).sort();
  }
}

export function entry(host: string, id: string, chap: number): string {
  return JSON.stringify({ host, thumb: "", name: `Book ${id}`, chapter: 0, id, current: `${chap}-,-Chương ${chap}: x` });
}

export class Clock {
  constructor(public t = 1_800_000_000_000) {}
  now = () => this.t;
  tick(ms = 1000): number {
    return (this.t += ms);
  }
}

export function device(drive: FakeDrive, id: string, clock: Clock, kv = memoryKV()) {
  const api = new Drive(async () => "token", drive.url);
  return { kv, engine: new SyncEngine(kv, api, "acct", { id, name: id }, clock.now) };
}
