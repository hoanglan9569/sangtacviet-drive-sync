import { afterAll, beforeEach, expect, test } from "bun:test";
import { type BackupVersion, dayOf, toPrune } from "../src/shared/backups";
import { FakeDrive } from "./fake-drive";
import { Clock, FakePage, device } from "./helpers";

const drive = new FakeDrive().start();
afterAll(() => drive.stop());
let clock: Clock;
beforeEach(() => {
  drive.files.clear();
  clock = new Clock();
});

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const N = "qidian100";

const v = (id: string, at: number, reason: BackupVersion["reason"] = "auto"): BackupVersion => ({ id, at, day: dayOf(at), deviceName: "", books: 0, names: 0, hash: id, reason });

test("toPrune keeps each saved day's newest versions, for the last N days that have any", () => {
  const now = new Date(2027, 0, 15, 20).getTime();
  const versions = [
    v("today-3", now - 1 * HOUR),
    v("today-2", now - 2 * HOUR),
    v("today-1", now - 3 * HOUR),
    v("6-days-ago", now - 6 * DAY),
    v("7-days-ago", now - 7 * DAY),
  ];
  // Only 3 saved days: nothing is too old, only today's third version goes.
  expect(toPrune(versions, { perDay: 2, days: 7 }).map((x) => x.id)).toEqual(["today-1"]);
  expect(toPrune(versions, { perDay: 2, days: 2 }).map((x) => x.id)).toEqual(["today-1", "7-days-ago"]);
});

test("days without versions do not count: 7 saved days years apart are all kept", () => {
  const start = new Date(2020, 0, 1, 12).getTime();
  const versions = Array.from({ length: 8 }, (_, d) => [v(`d${d}-a`, start + d * 365 * DAY), v(`d${d}-b`, start + d * 365 * DAY + HOUR)]).flat();
  // 8 saved days, a year apart: the oldest day goes, the other 7 days keep both versions (14).
  const pruned = toPrune(versions, { perDay: 2, days: 7 }).map((x) => x.id);
  expect(pruned.sort()).toEqual(["d0-a", "d0-b"]);
  expect(versions.length - pruned.length).toBe(14);
});

test("join versions neither count toward a day nor make a day count", () => {
  const now = new Date(2027, 0, 15, 20).getTime();
  const versions = [v("today", now), v("join-today", now - HOUR, "join"), v("join-old", now - 30 * DAY, "join"), v("yesterday", now - DAY)];
  expect(toPrune(versions, { perDay: 1, days: 2 }).map((x) => x.id)).toEqual([]);
  expect(toPrune(versions, { perDay: 1, days: 1 }).map((x) => x.id)).toEqual(["yesterday", "join-old"]);
});

test("every sync that changes the data saves a version; each day keeps its newest", async () => {
  const a = device(drive, "A", clock);
  const page = new FakePage(undefined, clock);
  page.read_("qidian", "100", 1);
  await a.engine.sync(page, page.times);
  expect(drive.byKind("backup")).toHaveLength(1);

  clock.tick(60 * 1000);
  await a.engine.sync(page, page.times);
  expect(drive.byKind("backup")).toHaveLength(1); // nothing changed

  clock.tick(60 * 1000);
  page.read_("qidian", "100", 2);
  await a.engine.sync(page, page.times);
  expect(drive.byKind("backup")).toHaveLength(2); // a minute later, still saved

  for (let chap = 3; chap <= 5; chap++) {
    clock.tick(60 * 1000);
    page.read_("qidian", "100", chap);
    await a.engine.sync(page, page.times);
  }
  const { versions, policy } = await a.engine.backups();
  expect(policy).toEqual({ perDay: 2, days: 7 });
  expect(versions).toHaveLength(2);
  expect(await a.engine.downloadBackup(versions[0]!.id)).toContain("Chương 5");

  await a.engine.setBackupPolicy({ perDay: 1, days: 3 });
  expect((await a.engine.backups()).policy).toEqual({ perDay: 1, days: 3 });
  expect((await a.engine.backups()).versions).toHaveLength(1);
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
  const good = (await a.engine.backups()).versions[0]!;

  // Something goes wrong: history emptied, a bad name added.
  clock.tick(10 * 60 * 1000);
  pb.ls.set("tusach", "");
  pb.times.tusach = clock.t;
  pb.addName(N, "$坏=Xấu");
  await b.engine.sync(pb, pb.times);
  await a.engine.sync(pa, pa.times);
  expect(pa.books()).toEqual([]);
  // The sync saved the bad data as a version; drop it so the restore has to save it itself.
  const bad = (await a.engine.backups()).versions.find((v) => v.books === 0)!;
  await a.engine.deleteBackup(bad.id);

  clock.tick();
  await a.engine.restoreBackup(good.id);
  await a.engine.sync(pa, pa.times);
  expect(pa.books()).toEqual(["100@5"]);
  expect(pa.names(N)).toEqual(["$伊莱=Y Lai"]);
  clock.tick();
  await b.engine.sync(pb, pb.times);
  expect(pb.books()).toEqual(["100@5"]);
  expect(pb.names(N)).toEqual(["$伊莱=Y Lai"]);

  const { versions } = await a.engine.backups();
  // The restored data stays saved (as the next automatic version, if the picked one rotated out).
  expect(versions.some((v) => v.hash === good.hash)).toBe(true);
  expect(versions.some((v) => v.reason === "restore" && v.books === 0)).toBe(true);
});

test("a version can be deleted and downloaded in the site's format", async () => {
  const a = device(drive, "A", clock);
  const page = new FakePage(undefined, clock);
  page.read_("qidian", "100", 5);
  await a.engine.sync(page, page.times);
  const [v] = (await a.engine.backups()).versions;
  expect(JSON.parse(await a.engine.downloadBackup(v!.id)).tusach).toBe(page.ls.get("tusach"));
  await a.engine.deleteBackup(v!.id);
  expect((await a.engine.backups()).versions).toEqual([]);
});
