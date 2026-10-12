/**
 * A browser joining an account that already has data: books only one side has,
 * the same book at different chapters, and names for books read on both.
 */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { FakeDrive } from "./fake-drive";
import { Clock, FakePage, device } from "./helpers";

const drive = new FakeDrive().start();
afterAll(() => drive.stop());
let clock: Clock;
beforeEach(() => {
  drive.files.clear();
  clock = new Clock();
});

const N = "qidian100";
const HOUR = 3600 * 1000;

/** A synced, B joins with its own data. */
async function joinWith(setupA: (p: FakePage) => void, setupB: (p: FakePage) => void) {
  const a = device(drive, "A", clock);
  const b = device(drive, "B", clock);
  const pa = new FakePage(undefined, clock);
  const pb = new FakePage(undefined, clock);
  setupA(pa);
  await a.engine.sync(pa, pa.times);
  clock.tick(HOUR);
  setupB(pb);
  await b.engine.sync(pb, pb.times);
  clock.tick();
  await a.engine.sync(pa, pa.times);
  return { a, b, pa, pb };
}

test("books only one side has end up on both", async () => {
  const { pa, pb } = await joinWith(
    (p) => p.read_("qidian", "100", 5),
    (p) => p.read_("fanqie", "200", 9),
  );
  expect(pa.books().sort()).toEqual(["100@5", "200@9"]);
  expect(pb.books().sort()).toEqual(["100@5", "200@9"]);
});

test("same book: the further chapter wins, even when the joining browser read it more recently", async () => {
  const { a, pa, pb } = await joinWith(
    (p) => p.read_("qidian", "100", 50),
    (p) => p.read_("qidian", "100", 3), // read an hour later, but far behind
  );
  expect(pa.books()).toEqual(["100@50"]);
  expect(pb.books()).toEqual(["100@50"]);
  // B's own chapter is kept as a version, in case it mattered.
  const join = (await a.engine.versions()).versions.find((v) => v.reason === "join");
  expect(join?.books).toBe(1);
  expect(await a.engine.downloadVersion(join!.id)).toContain("Chương 3");
});

test("same book: a joining browser that read further brings its chapter", async () => {
  const { pa, pb } = await joinWith(
    (p) => p.read_("qidian", "100", 3),
    (p) => p.read_("qidian", "100", 50),
  );
  expect(pa.books()).toEqual(["100@50"]);
  expect(pb.books()).toEqual(["100@50"]);
});

test("names: more or fewer on either side end up as the union, nothing deleted", async () => {
  const { pa, pb } = await joinWith(
    (p) => {
      p.read_("qidian", "100", 5);
      p.addName(N, "$伊莱=Y Lai");
      p.addName(N, "$崔泽=Thôi Trạch");
    },
    (p) => {
      p.read_("qidian", "100", 5);
      p.addName(N, "$伊莱=Y Lai");
      p.addName(N, "$乙=Ất");
    },
  );
  const all = ["$乙=Ất", "$伊莱=Y Lai", "$崔泽=Thôi Trạch"].sort();
  expect(pa.names(N)).toEqual(all);
  expect(pb.names(N)).toEqual(all);
});

test("names: a term the account already translates keeps the account's translation; the joiner's is saved as a version", async () => {
  const { a, pa, pb } = await joinWith(
    (p) => p.addName(N, "$伊莱=Y Lai"),
    (p) => p.addName(N, "$伊莱=Elai"),
  );
  expect(pa.names(N)).toEqual(["$伊莱=Y Lai"]);
  expect(pb.names(N)).toEqual(["$伊莱=Y Lai"]);
  const join = (await a.engine.versions()).versions.find((v) => v.reason === "join");
  expect(await a.engine.downloadVersion(join!.id)).toContain("Elai");
});

test("names: the site's appended edits leave one line per term, the last one", async () => {
  const a = device(drive, "A", clock);
  const pa = new FakePage(undefined, clock);
  pa.addName(N, "$伊莱=Y Lai");
  pa.addName(N, "$伊莱=Y Lại"); // the site's add-name appends, the old line stays
  await a.engine.sync(pa, pa.times);
  expect(pa.names(N)).toEqual(["$伊莱=Y Lại"]);

  clock.tick();
  pa.addName(N, "$伊莱=Ylai");
  await a.engine.sync(pa, pa.times);
  expect(pa.names(N)).toEqual(["$伊莱=Ylai"]);
});

test("names: after joining, a renamed term reaches the other browser and replaces the old translation", async () => {
  const { a, b, pa, pb } = await joinWith(
    (p) => p.addName(N, "$伊莱=Y Lai"),
    () => {},
  );
  clock.tick();
  pb.removeName(N, "$伊莱=Y Lai");
  pb.addName(N, "$伊莱=Y Lại");
  await b.engine.sync(pb, pb.times);
  clock.tick();
  await a.engine.sync(pa, pa.times);
  expect(pa.names(N)).toEqual(["$伊莱=Y Lại"]);

  // Both rename the same term before syncing: the later change wins everywhere.
  clock.tick();
  pa.addName(N, "$伊莱=A's");
  clock.tick();
  pb.addName(N, "$伊莱=B's");
  await a.engine.sync(pa, pa.times);
  await b.engine.sync(pb, pb.times);
  clock.tick();
  await a.engine.sync(pa, pa.times);
  expect(pa.names(N)).toEqual(["$伊莱=B's"]);
  expect(pb.names(N)).toEqual(["$伊莱=B's"]);
});
