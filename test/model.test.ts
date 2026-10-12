import { expect, test } from "bun:test";
import { type Items, absorbLocal, buildSnapshot, liveItems, mergeItems, planWrites } from "../src/shared/model";
import { nameKeyMatcher } from "../src/shared/sitedata";
import { entry } from "./helpers";

test("name keys follow the site's export rule, plus dich and qtOnline0", () => {
  const isName = nameKeyMatcher(["newhost"]);
  for (const k of ["qidian1050807668", "-aikanshu12", "dich53484", "qtOnline0", "newhost7"]) expect(isName(k)).toBe(true);
  for (const k of ["tusach", "setting", "fontsize2", "aqidian1050807668", "qidian"]) expect(isName(k)).toBe(false);
});

test("snapshot -> items -> snapshot keeps the page's exact strings", () => {
  const s = {
    tusach: [entry("qidian", "1", 3), entry("fanqie", "2", 9)].join("~/~"),
    names: { qidian1: "$乙=Ất~//~$甲=Giáp~//~", dich5: "$丙=Bính" },
  };
  const items: Items = {};
  absorbLocal(items, s, null, { now: 1000 });
  expect(buildSnapshot(items, s)).toEqual(s);
  expect(planWrites(s, buildSnapshot(items, s)).set).toEqual({});
});

test("merge is order-independent", () => {
  const a: Items = { x: { t: 1, v: "a" }, y: { t: 5, v: null } };
  const b: Items = { x: { t: 2, v: "b" }, y: { t: 4, v: "keep?" }, z: { t: 1, v: "z" } };
  const ab: Items = structuredClone(a);
  mergeItems(ab, b);
  const ba: Items = structuredClone(b);
  mergeItems(ba, a);
  expect(ab).toEqual(ba);
  expect(ab.y!.v).toBeNull();
});

test("equal timestamps resolve the same way everywhere", () => {
  const a: Items = { x: { t: 1, v: "a" } };
  mergeItems(a, { x: { t: 1, v: "b" } });
  const b: Items = { x: { t: 1, v: "b" } };
  mergeItems(b, { x: { t: 1, v: "a" } });
  expect(a).toEqual(b);
});

test("re-reading a book bumps it to the front", () => {
  const e1 = entry("qidian", "1", 3);
  const e2 = entry("qidian", "2", 4);
  const shadow = { tusach: [e2, e1].join("~/~"), names: {} };
  const items: Items = {};
  absorbLocal(items, shadow, null, { now: 1000 });
  const local = { tusach: [e1, e2].join("~/~"), names: {} };
  absorbLocal(items, local, shadow, { now: 2000 });
  expect(liveItems(buildSnapshot(items, shadow)).order[0]).toContain("-1");
});

test("new names are appended after the page's own order", () => {
  const base = { tusach: null, names: { qidian1: "$乙=Ất~//~$甲=Giáp~//~" } };
  const items: Items = {};
  absorbLocal(items, base, null, { now: 1000 });
  mergeItems(items, { "n\u001fqidian1\u001f$丙=Bính": { t: 2000, v: "" } });
  expect(buildSnapshot(items, base).names.qidian1).toBe("$乙=Ất~//~$甲=Giáp~//~$丙=Bính~//~");
});
