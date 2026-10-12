import { afterAll, beforeEach, expect, test } from "bun:test";
import { type Version, KEEP_FOREVER, dayOf, toRelease } from "../src/shared/versions";
import { FakeDrive } from "./fake-drive";
import { Clock, FakePage, device } from "./helpers";

const drive = new FakeDrive().start();
afterAll(() => drive.stop());
let clock: Clock;
beforeEach(() => {
  drive.files.clear();
  clock = new Clock();
  drive.now = clock.now;
});

const N = "qidian100";

const rev = (n: number, extra: Partial<Version> = {}): Version => ({ id: `rev:f:r${n}`, at: n, day: dayOf(n), deviceName: "", reason: "auto", ...extra });

test(`past ${KEEP_FOREVER} versions kept forever, the oldest become temporary; never the latest, temporary ones or files`, () => {
  const kept = Array.from({ length: KEEP_FOREVER + 3 }, (_, i) => rev(i + 1, { current: i === KEEP_FOREVER + 2 }));
  const others = [rev(0, { temporary: true }), { ...rev(-1), id: "file1", reason: "join" as const }];
  expect(toRelease([...kept, ...others]).map((v) => v.id)).toEqual(["rev:f:r3", "rev:f:r2", "rev:f:r1"]);
  expect(toRelease(kept.slice(0, KEEP_FOREVER))).toEqual([]);
});

test("every sync that changes the data saves a version of dulieu.txt, kept forever", async () => {
  const a = device(drive, "A", clock);
  const page = new FakePage(undefined, clock);
  const count = async () => (await a.engine.versions()).versions.length;
  page.read_("qidian", "100", 1);
  await a.engine.sync(page, page.times);
  expect(await count()).toBe(1);
  expect(drive.byKind("backup")).toHaveLength(0); // no separate files: dulieu.txt's own revisions

  clock.tick(60 * 1000);
  await a.engine.sync(page, page.times);
  expect(await count()).toBe(1); // nothing changed

  for (let chap = 2; chap <= 5; chap++) {
    clock.tick(60 * 1000);
    page.read_("qidian", "100", chap);
    await a.engine.sync(page, page.times);
  }
  const { versions } = await a.engine.versions();
  expect(versions).toHaveLength(5);
  expect(versions.every((v) => !v.temporary)).toBe(true);
  expect(versions[0]).toMatchObject({ current: true, deviceName: "A", books: 1, names: 0 });
  expect(await a.engine.downloadVersion(versions[0]!.id)).toContain("Chương 5");
  expect(await a.engine.downloadVersion(versions[4]!.id)).toContain("Chương 1");
});
test("restoring a version brings it back in every browser, and saves the current data first", async () => {
  const a = device(drive, "A", clock);
  const b = device(drive, "B", clock);
  const pa = new FakePage(undefined, clock);
  const pb = new FakePage(undefined, clock);
  pa.read_("qidian", "100", 5);
  pa.addName(N, "$伊莱=Y Lai");
  await a.engine.sync(pa, pa.times);
  await b.engine.sync(pb, pb.times);
  const good = (await a.engine.versions()).versions[0]!;
  const goodText = await a.engine.downloadVersion(good.id);

  // Something goes wrong: history emptied, a bad name added.
  clock.tick(10 * 60 * 1000);
  pb.ls.set("tusach", "");
  pb.times.tusach = clock.t;
  pb.addName(N, "$坏=Xấu");
  await b.engine.sync(pb, pb.times);
  await a.engine.sync(pa, pa.times);
  expect(pa.books()).toEqual([]);

  clock.tick();
  await a.engine.restoreVersion(good.id);
  await a.engine.sync(pa, pa.times);
  expect(pa.books()).toEqual(["100@5"]);
  expect(pa.names(N)).toEqual(["$伊莱=Y Lai"]);
  clock.tick();
  await b.engine.sync(pb, pb.times);
  expect(pb.books()).toEqual(["100@5"]);
  expect(pb.names(N)).toEqual(["$伊莱=Y Lai"]);

  const { versions } = await a.engine.versions();
  // dulieu.txt holds the restored data again; the data it replaced stays as a version.
  expect(versions[0]!.current).toBe(true);
  expect(await a.engine.downloadVersion(versions[0]!.id)).toBe(goodText);
  const texts = await Promise.all(versions.map((v) => a.engine.downloadVersion(v.id)));
  expect(texts.some((t) => t.includes("Xấu"))).toBe(true);
});

test("a version can be deleted and downloaded in the site's format", async () => {
  const a = device(drive, "A", clock);
  const page = new FakePage(undefined, clock);
  page.read_("qidian", "100", 5);
  await a.engine.sync(page, page.times);
  const before = page.ls.get("tusach");
  clock.tick(60 * 1000);
  page.read_("qidian", "100", 6);
  await a.engine.sync(page, page.times);
  const [current, older] = (await a.engine.versions()).versions;
  expect(JSON.parse(await a.engine.downloadVersion(older!.id)).tusach).toBe(before);
  await a.engine.deleteVersion(older!.id);
  expect((await a.engine.versions()).versions.map((v) => v.id)).toEqual([current!.id]);
  // dulieu.txt's current content cannot be deleted.
  expect(a.engine.deleteVersion(current!.id)).rejects.toThrow();
});

test("version files from older releases still show", async () => {
  const a = device(drive, "A", clock);
  const page = new FakePage(undefined, clock);
  page.read_("qidian", "100", 1);
  await a.engine.sync(page, page.times);
  const { Drive } = await import("../src/shared/drive");
  const api = new Drive(async () => "t", drive.url);
  const old = (day: number) =>
    api.create(
      { name: `backup old ${day}.txt`, appProperties: { stvSync: "backup", at: String(clock.t - day * 86_400_000), books: "7", names: "0", deviceName: "Old" } },
      JSON.stringify({ name: {}, tusach: "" }),
      "text/plain",
    );
  for (const d of [1, 2, 3]) await old(d);
  expect((await a.engine.versions()).versions.map((v) => v.books)).toEqual([1, 7, 7, 7]);
});

test("temporary revisions (not kept forever) are listed like Drive lists them, downloadable and deletable, and left to Drive", async () => {
  const a = device(drive, "A", clock);
  const page = new FakePage(undefined, clock);
  page.read_("qidian", "100", 1);
  await a.engine.sync(page, page.times);
  // What an older release, or Drive ignoring the flag, leaves: revisions not kept forever.
  const { Drive } = await import("../src/shared/drive");
  const api = new Drive(async () => "t", drive.url);
  const exp = drive.byKind("export")[0]!;
  for (const n of [1, 2, 3]) {
    clock.tick(60_000);
    await api.update(exp.id, `{"name":{},"tusach":"old ${n}"}`, "text/plain", { appProperties: { hash: `old${n}` } });
  }
  let { versions } = await a.engine.versions();
  expect(versions.map((v) => [v.current ?? false, v.temporary])).toEqual([
    [true, true],
    [false, true],
    [false, true],
    [false, false],
  ]);
  // Downloading a temporary one keeps it only for the download.
  expect(await a.engine.downloadVersion(versions[2]!.id)).toContain("old 1");
  expect((await a.engine.versions()).versions[2]!.temporary).toBe(true);
  await a.engine.deleteVersion(versions[2]!.id);
  expect((await a.engine.versions()).versions).toHaveLength(3);

  // The next version this browser saves is kept forever; temporary ones stay for Drive to delete.
  clock.tick(60_000);
  page.read_("qidian", "100", 2);
  await a.engine.sync(page, page.times);
  versions = (await a.engine.versions()).versions;
  expect(versions[0]).toMatchObject({ current: true, temporary: false });
  expect(versions.filter((v) => v.temporary)).toHaveLength(2);
  expect(versions.filter((v) => !v.temporary)).toHaveLength(2);
});

test("each new version ends up kept forever, even if Drive ignored the upload's flag; the latest can never be deleted", async () => {
  const a = device(drive, "A", clock);
  const page = new FakePage(undefined, clock);
  drive.honourKeep = false;
  try {
    for (const chap of [1, 2]) {
      clock.tick(60_000);
      page.read_("qidian", "100", chap);
      await a.engine.sync(page, page.times);
    }
  } finally {
    drive.honourKeep = true;
  }
  const { versions } = await a.engine.versions();
  expect(versions.map((v) => v.temporary)).toEqual([false, false]);
  expect(versions[0]!.current).toBe(true);
  expect(a.engine.deleteVersion(versions[0]!.id)).rejects.toThrow("can't be deleted");
  await a.engine.deleteVersion(versions[1]!.id);
  expect((await a.engine.versions()).versions).toHaveLength(1);
});

test(`with more than ${KEEP_FOREVER} versions, the oldest become temporary and nothing hits Drive's limit of 200`, async () => {
  const a = device(drive, "A", clock);
  const page = new FakePage(undefined, clock);
  for (let chap = 1; chap <= KEEP_FOREVER + 25; chap++) {
    clock.tick(60_000);
    page.read_("qidian", "100", chap);
    await a.engine.sync(page, page.times);
  }
  const { versions } = await a.engine.versions();
  expect(versions.filter((v) => !v.temporary)).toHaveLength(KEEP_FOREVER);
  expect(versions.filter((v) => v.temporary)).toHaveLength(25);
  expect(versions[0]).toMatchObject({ current: true, temporary: false });
  expect(versions.at(-1)!.temporary).toBe(true);
});