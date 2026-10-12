import { afterAll, beforeEach, expect, test } from "bun:test";
import { FakeDrive } from "./fake-drive";
import { DeviceRemovedError } from "../src/shared/engine";
import { Clock, FakePage, device } from "./helpers";

const drive = new FakeDrive().start();
afterAll(() => drive.stop());
let clock: Clock;
beforeEach(() => {
  drive.files.clear();
  clock = new Clock();
});

const N = "qidian100";

test("first browser uploads its data as a device file and a site-format dulieu.txt", async () => {
  const a = device(drive, "A", clock);
  const page = new FakePage(undefined, clock);
  page.read_("qidian", "100", 5);
  page.addName(N, "$伊莱=Y Lai");

  const r = await a.engine.sync(page, page.times);
  expect(r.pushed).toBe(true);
  expect(r.written).toEqual([]);
  expect(drive.byKind("root")).toHaveLength(1);
  expect(drive.byKind("device")).toHaveLength(1);
  const exp = JSON.parse(drive.byKind("export")[0]!.content) as { name: Record<string, string>; tusach: string };
  expect(Object.keys(exp)).toEqual(["name", "tusach"]);
  expect(exp.name[N]).toBe("$伊莱=Y Lai~//~");
  expect(exp.tusach).toBe(page.ls.get("tusach")!);
});

test("a second browser merges both ways: union of history and names", async () => {
  const a = device(drive, "A", clock);
  const b = device(drive, "B", clock);
  const pa = new FakePage(undefined, clock);
  const pb = new FakePage(undefined, clock);
  pa.read_("qidian", "100", 5);
  pa.addName(N, "$伊莱=Y Lai");
  await a.engine.sync(pa, pa.times);

  clock.tick();
  pb.read_("fanqie", "200", 9);
  pb.addName(N, "$崔泽=Thôi Trạch");
  await b.engine.sync(pb, pb.times);
  expect(pb.books()).toEqual(["200@9", "100@5"]);
  expect(pb.names(N)).toEqual(["$伊莱=Y Lai", "$崔泽=Thôi Trạch"]);

  clock.tick();
  await a.engine.sync(pa, pa.times);
  expect(pa.books()).toEqual(["200@9", "100@5"]);
  expect(pa.names(N)).toEqual(["$伊莱=Y Lai", "$崔泽=Thôi Trạch"]);
});

test("a stale browser never overwrites newer progress", async () => {
  const a = device(drive, "A", clock);
  const b = device(drive, "B", clock);
  const pa = new FakePage(undefined, clock);
  const pb = new FakePage(undefined, clock);
  pa.read_("qidian", "100", 5);
  await a.engine.sync(pa, pa.times);
  clock.tick();
  await b.engine.sync(pb, pb.times);
  expect(pb.books()).toEqual(["100@5"]);

  clock.tick();
  pa.read_("qidian", "100", 6);
  await a.engine.sync(pa, pa.times);
  clock.tick();
  await b.engine.sync(pb, pb.times); // B did nothing: it must take chapter 6, not push 5 back
  expect(pb.books()).toEqual(["100@6"]);
  clock.tick();
  await a.engine.sync(pa, pa.times);
  expect(pa.books()).toEqual(["100@6"]);
});

test("the later read of the same book wins, and history is ordered by recency", async () => {
  const a = device(drive, "A", clock);
  const b = device(drive, "B", clock);
  const pa = new FakePage(undefined, clock);
  const pb = new FakePage(undefined, clock);
  pa.read_("qidian", "100", 5);
  pa.read_("qidian", "101", 1);
  await a.engine.sync(pa, pa.times);
  await b.engine.sync(pb, pb.times);

  clock.tick();
  pa.read_("qidian", "100", 7); // A reads 100 ch.7 (offline)
  clock.tick();
  pb.read_("qidian", "100", 8); // B reads 100 ch.8 later (offline)
  clock.tick();
  pb.read_("qidian", "101", 2); // then 101
  await a.engine.sync(pa, pa.times);
  await b.engine.sync(pb, pb.times);
  await a.engine.sync(pa, pa.times);
  expect(pa.books()).toEqual(["101@2", "100@8"]);
  expect(pb.books()).toEqual(["101@2", "100@8"]);
});

test("deletions propagate and are not resurrected by a browser that still has the item", async () => {
  const a = device(drive, "A", clock);
  const b = device(drive, "B", clock);
  const pa = new FakePage(undefined, clock);
  const pb = new FakePage(undefined, clock);
  pa.read_("qidian", "100", 5);
  pa.read_("qidian", "101", 1);
  pa.addName(N, "$甲=Giáp");
  pa.addName(N, "$乙=Ất");
  await a.engine.sync(pa, pa.times);
  await b.engine.sync(pb, pb.times);

  clock.tick();
  pa.ls.set("tusach", pa.ls.get("tusach")!.split("~/~").filter((e) => !e.includes('"id":"100"')).join("~/~"));
  pa.removeName(N, "$乙=Ất");
  await a.engine.sync(pa, pa.times);
  clock.tick();
  await b.engine.sync(pb, pb.times);
  expect(pb.books()).toEqual(["101@1"]);
  expect(pb.names(N)).toEqual(["$甲=Giáp"]);
  await a.engine.sync(pa, pa.times);
  expect(pa.books()).toEqual(["101@1"]);
});

test("names added to the same book on two browsers at once both survive", async () => {
  const a = device(drive, "A", clock);
  const b = device(drive, "B", clock);
  const pa = new FakePage(undefined, clock);
  const pb = new FakePage(undefined, clock);
  pa.addName(N, "$甲=Giáp");
  await a.engine.sync(pa, pa.times);
  await b.engine.sync(pb, pb.times);

  clock.tick();
  pa.addName(N, "$乙=Ất");
  pb.addName(N, "$丙=Bính");
  await a.engine.sync(pa, pa.times);
  await b.engine.sync(pb, pb.times);
  await a.engine.sync(pa, pa.times);
  expect(pa.names(N)).toEqual(["$丙=Bính", "$乙=Ất", "$甲=Giáp"]);
  expect(pb.names(N)).toEqual(pa.names(N));
});

test("a page write during sync is not lost (compare-and-set retries)", async () => {
  const a = device(drive, "A", clock);
  const b = device(drive, "B", clock);
  const pa = new FakePage(undefined, clock);
  const pb = new FakePage(undefined, clock);
  pa.addName(N, "$甲=Giáp");
  await a.engine.sync(pa, pa.times);

  pb.addName(N, "$乙=Ất");
  pb.beforeApply = () => pb.addName(N, "$丙=Bính");
  await b.engine.sync(pb, pb.times);
  expect(pb.names(N)).toEqual(["$丙=Bính", "$乙=Ất", "$甲=Giáp"]);
  await a.engine.sync(pa, pa.times);
  expect(pa.names(N)).toEqual(pb.names(N));
});

test("two sangtacviet domains in one browser end up with the same data", async () => {
  const a = device(drive, "A", clock);
  const com = new FakePage("https://sangtacviet.com", clock);
  const app = new FakePage("https://sangtacviet.app", clock);
  com.read_("qidian", "100", 5);
  app.read_("fanqie", "200", 3);
  app.addName("fanqie200", "$丁=Đinh");
  await a.engine.sync(com, com.times);
  await a.engine.sync(app, app.times);
  await a.engine.sync(com, com.times);
  expect(com.books().sort()).toEqual(["100@5", "200@3"]);
  expect(app.books().sort()).toEqual(["100@5", "200@3"]);
  expect(com.names("fanqie200")).toEqual(["$丁=Đinh"]);
});

test("first sync of a browser that read further keeps the further chapter", async () => {
  const a = device(drive, "A", clock);
  const b = device(drive, "B", clock);
  const pa = new FakePage(undefined, clock);
  const pb = new FakePage(undefined, clock);
  pa.read_("qidian", "100", 5);
  await a.engine.sync(pa, pa.times);
  pb.read_("qidian", "100", 40); // B had read further before installing the extension
  clock.tick();
  await b.engine.sync(pb, pb.times);
  await a.engine.sync(pa, pa.times);
  expect(pa.books()).toEqual(["100@40"]);
  expect(pb.books()).toEqual(["100@40"]);
});

test("an idle sync uploads nothing", async () => {
  const a = device(drive, "A", clock);
  const pa = new FakePage(undefined, clock);
  pa.read_("qidian", "100", 5);
  await a.engine.sync(pa, pa.times);
  drive.log.length = 0;
  const r = await a.engine.sync(pa, pa.times);
  expect(r.pushed).toBe(false);
  expect(drive.log.filter((l) => !l.startsWith("GET"))).toEqual([]);
});

test("summary reports an existing backup to a new account link", async () => {
  const a = device(drive, "A", clock);
  const b = device(drive, "B", clock);
  expect((await b.engine.summary()).exists).toBe(false);
  const pa = new FakePage(undefined, clock);
  pa.read_("qidian", "100", 5);
  await a.engine.sync(pa, pa.times);
  const s = await b.engine.summary();
  expect(s.exists).toBe(true);
  expect(s.devices.map((d) => [d.id, d.self])).toEqual([["A", false]]);
});

test("a browser renamed from another one takes the new name and keeps it", async () => {
  const a = device(drive, "A", clock);
  const b = device(drive, "B", clock);
  const pa = new FakePage(undefined, clock);
  const pb = new FakePage(undefined, clock);
  pa.read_("qidian", "100", 5);
  await a.engine.sync(pa, pa.times);
  await b.engine.sync(pb, pb.times);

  await a.engine.renameDevice("B", "Laptop", clock.tick());
  expect((await a.engine.listDevices()).map((d) => [d.id, d.name])).toEqual([["A", "A"], ["B", "Laptop"]]);
  const r = await b.engine.sync(pb, pb.times);
  expect(r.device).toEqual({ id: "B", name: "Laptop", nameAt: clock.t });

  clock.tick();
  pb.read_("qidian", "100", 6); // B pushes again: the new name must survive it
  await b.engine.sync(pb, pb.times);
  expect((await a.engine.listDevices()).find((d) => d.id === "B")?.name).toBe("Laptop");
});

test("a removed browser stops syncing; what it synced stays, and linking again re-adds it", async () => {
  const a = device(drive, "A", clock);
  const b = device(drive, "B", clock);
  const pa = new FakePage(undefined, clock);
  const pb = new FakePage(undefined, clock);
  pb.read_("fanqie", "200", 9);
  await b.engine.sync(pb, pb.times);
  await a.engine.sync(pa, pa.times);

  await a.engine.removeDevice("B");
  expect((await a.engine.listDevices()).map((d) => d.id)).toEqual(["A"]);
  expect(drive.byKind("device")).toHaveLength(1);
  clock.tick();
  await a.engine.sync(pa, pa.times);
  expect(pa.books()).toEqual(["200@9"]);

  clock.tick();
  pb.read_("fanqie", "200", 10);
  await expect(b.engine.sync(pb, pb.times)).rejects.toBeInstanceOf(DeviceRemovedError);
  await b.engine.forget(); // what the extension does on DeviceRemovedError
  await b.engine.sync(pb, pb.times);
  expect((await a.engine.listDevices()).map((d) => d.id).sort()).toEqual(["A", "B"]);
});

test("removing this browser trashes its file and forgets its sync state", async () => {
  const a = device(drive, "A", clock);
  const pa = new FakePage(undefined, clock);
  pa.read_("qidian", "100", 5);
  await a.engine.sync(pa, pa.times);
  await a.engine.removeDevice("A");
  expect(drive.byKind("device")).toHaveLength(0);
  expect([...a.kv.data.keys()]).toEqual([]);
});
