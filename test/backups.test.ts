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

test("toPrune keeps the newest versions of each day and the last N days", () => {
  const now = new Date(2027, 0, 15, 20).getTime();
  const v = (id: string, at: number): BackupVersion => ({ id, at, day: dayOf(at), deviceName: "", books: 0, names: 0, hash: id, reason: "auto" });
  const versions = [
    v("today-3", now - 1 * HOUR),
    v("today-2", now - 2 * HOUR),
    v("today-1", now - 3 * HOUR),
    v("6-days-ago", now - 6 * DAY),
    v("7-days-ago", now - 7 * DAY),
  ];
  expect(toPrune(versions, { perDay: 2, days: 7 }, now).map((x) => x.id)).toEqual(["today-1", "7-days-ago"]);
  // A browser whose clock is far ahead still keeps the newest version.
  expect(toPrune(versions, { perDay: 2, days: 7 }, now + 365 * DAY).map((x) => x.id)).toEqual(["today-2", "today-1", "6-days-ago", "7-days-ago"]);
});

test("syncs save a version when the data changed, at most once an hour, and rotate per the policy", async () => {
  const a = device(drive, "A", clock);
  const page = new FakePage(undefined, clock);
  page.read_("qidian", "100", 1);
  await a.engine.sync(page, page.times);
  expect(drive.byKind("backup")).toHaveLength(1);

  clock.tick(10 * 60 * 1000);
  page.read_("qidian", "100", 2);
  await a.engine.sync(page, page.times);
  expect(drive.byKind("backup")).toHaveLength(1); // within the hour

  clock.tick(HOUR);
  await a.engine.sync(page, page.times);
  expect(drive.byKind("backup")).toHaveLength(2);
  clock.tick(HOUR);
  await a.engine.sync(page, page.times);
  expect(drive.byKind("backup")).toHaveLength(2); // nothing changed since the last version

  for (let chap = 3; chap <= 5; chap++) {
    clock.tick(HOUR);
    page.read_("qidian", "100", chap);
    await a.engine.sync(page, page.times);
  }
  const { versions, policy } = await a.engine.backups();
  expect(policy).toEqual({ perDay: 2, days: 7 });
  const today = versions.filter((v) => v.day === dayOf(clock.t));
  expect(today.length).toBeLessThanOrEqual(2);
  expect(versions[0]!.books).toBe(1);

  await a.engine.setBackupPolicy({ perDay: 1, days: 3 });
  expect((await a.engine.backups()).policy).toEqual({ perDay: 1, days: 3 });
  expect((await a.engine.backups()).versions.filter((v) => v.day === dayOf(clock.t))).toHaveLength(1);
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

  // Something goes wrong within the hour (no automatic version yet): history emptied, a bad name added.
  clock.tick(10 * 60 * 1000);
  pb.ls.set("tusach", "");
  pb.times.tusach = clock.t;
  pb.addName(N, "$坏=Xấu");
  await b.engine.sync(pb, pb.times);
  await a.engine.sync(pa, pa.times);
  expect(pa.books()).toEqual([]);

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
  expect(versions.some((v) => v.id === good.id)).toBe(true);
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
