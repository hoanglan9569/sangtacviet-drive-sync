import { afterAll, beforeEach, expect, test } from "bun:test";
import { COMPACT_AT } from "../src/shared/engine";
import { FakeDrive } from "./fake-drive";
import { Clock, FakePage, device, entry } from "./helpers";

const drive = new FakeDrive().start();
afterAll(() => drive.stop());
let clock: Clock;
beforeEach(() => {
  drive.files.clear();
  drive.log.length = 0;
  clock = new Clock();
});

const N = "qidian100";
const ids = (kind: string) => new Set(drive.byKind(kind).map((f) => f.id));
/** Requests since the last call, as "METHOD kind" ("GET ops" = a download of a change file). */
function requests(): string[] {
  const kinds = new Map([...drive.files.values()].map((f) => [f.id, f.appProperties?.stvSync ?? "?"]));
  const out = drive.log.map((l) => {
    const [method, path] = l.split(" ");
    const id = /\/files\/([^/]+)/.exec(path!)?.[1];
    return `${method} ${id ? (kinds.get(id) ?? "gone") : path!.startsWith("/upload") ? "upload" : "list"}`;
  });
  drive.log.length = 0;
  return out;
}

async function twoBrowsers(books = 50) {
  const a = device(drive, "A", clock);
  const b = device(drive, "B", clock);
  const pa = new FakePage(undefined, clock);
  const pb = new FakePage(undefined, clock);
  for (let i = 0; i < books; i++) pa.read_("qidian", String(i), 1);
  pa.addName(N, "$伊莱=Y Lai");
  await a.engine.sync(pa, pa.times);
  clock.tick();
  await b.engine.sync(pb, pb.times);
  clock.tick();
  await a.engine.sync(pa, pa.times);
  requests();
  return { a, b, pa, pb };
}

test("a small change uploads a change file, not the whole data; the other browser downloads only that", async () => {
  const { a, b, pa, pb } = await twoBrowsers();
  const device = drive.byKind("device").find((f) => f.appProperties?.device === "A")!;
  const before = device.content;

  clock.tick();
  pa.read_("qidian", "7", 2);
  await a.engine.sync(pa, pa.times);
  expect(device.content).toBe(before); // the device file is left alone
  const [change] = drive.byKind("ops");
  expect(change!.content.length).toBeLessThan(500);
  expect(Object.keys(JSON.parse(change!.content).items)).toEqual(["t\u001fqidian-7"]);
  // list and the change file, then dulieu.txt, its copy as a backup version, and the rotation
  const sent = requests();
  expect(sent.slice(0, 4)).toEqual(["GET list", "POST upload", "PATCH export", "POST export"]);
  expect(sent.slice(4).every((r) => r === "DELETE gone")).toBe(true);

  clock.tick();
  await b.engine.sync(pb, pb.times);
  expect(pb.books()[0]).toBe("7@2");
  // B downloads the one change file and uploads nothing: dulieu.txt and the backup already hold this data.
  expect(requests()).toEqual(["GET list", "GET ops"]);
});

test("a backup version is a server-side copy of dulieu.txt", async () => {
  const { a, pa } = await twoBrowsers(3);
  clock.tick();
  pa.read_("qidian", "1", 9);
  await a.engine.sync(pa, pa.times);
  expect(drive.log.filter((l) => l.endsWith("/copy"))).toHaveLength(1);
  const [exp] = drive.byKind("export");
  const { versions } = await a.engine.backups();
  expect(versions[0]!.hash).toBe(exp!.appProperties!.hash!);
  expect(await a.engine.downloadBackup(versions[0]!.id)).toBe(exp!.content);
});

test(`after ${COMPACT_AT} change files they are folded into the device file`, async () => {
  const { a, b, pa, pb } = await twoBrowsers(3);
  const c = device(drive, "C", clock);
  const pc = new FakePage(undefined, clock);
  await c.engine.sync(pc, pc.times); // C joins, then stays away

  for (let chap = 2; chap <= COMPACT_AT + 5; chap++) {
    clock.tick();
    pa.read_("qidian", "1", chap);
    await a.engine.sync(pa, pa.times);
    if (chap % 3 === 0) await b.engine.sync(pb, pb.times); // B keeps up
  }
  const own = [...drive.files.values()].filter((f) => f.appProperties?.stvSync === "ops" && f.appProperties.device === "A");
  expect(own.length).toBeLessThan(COMPACT_AT);
  const base = drive.byKind("device").find((f) => f.appProperties?.device === "A")!;
  expect(Number(base.appProperties!.upTo)).toBeGreaterThan(COMPACT_AT);

  requests();
  await b.engine.sync(pb, pb.times);
  expect(pb.books()[0]).toBe(`1@${COMPACT_AT + 5}`);
  await c.engine.sync(pc, pc.times); // too far behind for the change files: reads the device file
  expect(pc.books()[0]).toBe(`1@${COMPACT_AT + 5}`);
  expect(pc.books()).toEqual(pa.books());
});

test("a browser that kept up never downloads the folded device file", async () => {
  const { a, b, pa, pb } = await twoBrowsers(3);
  const baseId = drive.byKind("device").find((f) => f.appProperties?.device === "A")!.id;
  for (let chap = 2; chap <= COMPACT_AT + 5; chap++) {
    clock.tick();
    pa.read_("qidian", "1", chap);
    await a.engine.sync(pa, pa.times);
    drive.log.length = 0;
    await b.engine.sync(pb, pb.times);
    // The device file's own change number is the only gap; B reads the file once, when A folds.
    const reads = drive.log.filter((l) => l === `GET /drive/v3/files/${baseId}`);
    expect(reads.length).toBeLessThanOrEqual(1);
  }
  expect(pb.books()).toEqual(pa.books());
});

test("a browser still on the old whole-file format syncs both ways", async () => {
  const a = device(drive, "A", clock);
  const pa = new FakePage(undefined, clock);
  pa.read_("qidian", "100", 5);
  await a.engine.sync(pa, pa.times);

  // What an older version of the extension writes: the whole data, no `upTo`, no change files.
  const old = { format: "stv-drive-sync/device", v: 1, device: { id: "OLD", name: "Old" }, updated: clock.t, items: { "t\u001fqidian-200": [clock.t, entry("qidian", "200", 3)] } };
  const { Drive } = await import("../src/shared/drive");
  const api = new Drive(async () => "t", drive.url);
  const f = await api.create({ name: "device-OLD.json", appProperties: { stvSync: "device", device: "OLD", deviceName: "Old" } }, JSON.stringify(old), "application/json");
  clock.tick();
  await a.engine.sync(pa, pa.times);
  expect(pa.books().sort()).toEqual(["100@5", "200@3"]);

  // It reads A's device file (whole data, as before): it holds A's changes too.
  clock.tick();
  pa.read_("qidian", "100", 6);
  await a.engine.sync(pa, pa.times);
  for (let i = 0; i < COMPACT_AT; i++) {
    clock.tick();
    pa.addName(N, `$名${i}=Danh ${i}`);
    await a.engine.sync(pa, pa.times);
  }
  const base = JSON.parse(drive.byKind("device").find((x) => x.appProperties?.device === "A")!.content);
  expect(base.items["t\u001fqidian-100"][1]).toContain("6-,-");
  expect(drive.files.has(f.id)).toBe(true);
});

test("a browser upgraded from the old format rewrites its device file once, then sends change files", async () => {
  const a = device(drive, "A", clock);
  const pa = new FakePage(undefined, clock);
  pa.read_("qidian", "100", 5);
  await a.engine.sync(pa, pa.times);
  const base = drive.byKind("device")[0]!;
  delete base.appProperties!.upTo; // as written by the old version
  clock.tick();
  pa.read_("qidian", "100", 6);
  await a.engine.sync(pa, pa.times);
  expect(base.appProperties!.upTo).toBeDefined();
  expect(drive.byKind("ops")).toHaveLength(0);
  clock.tick();
  pa.read_("qidian", "100", 7);
  await a.engine.sync(pa, pa.times);
  expect(drive.byKind("ops")).toHaveLength(1);
});

test("removing a browser trashes its change files too", async () => {
  const { a, b, pb } = await twoBrowsers(3);
  clock.tick();
  pb.read_("qidian", "9", 9);
  await b.engine.sync(pb, pb.times);
  expect([...ids("ops")].length).toBeGreaterThan(0);
  await a.engine.removeDevice("B");
  expect(drive.byKind("ops").filter((f) => f.appProperties?.device === "B")).toEqual([]);
});
