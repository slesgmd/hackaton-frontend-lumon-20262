import assert from "node:assert/strict";
import { test } from "node:test";
import {
  UnknownStrategyError,
  binForDigits,
  collectGroup,
  type BinCode,
  type GroupRules,
  type GroupSource,
} from "../src/lib/group.ts";

/** Dibuja la grilla con texto: "#" da miedo (tremor 90), "." no (tremor 10), "r" ya refinada. */
function makeSource(picture: string[], tileSize: number, digit = (r: number, c: number) => (r + c) % 10) {
  const rows = picture.length;
  const cols = (picture[0] ?? "").length;
  const loaded = new Set<string>();
  const requested: string[] = [];
  const src: GroupSource = {
    rows,
    cols,
    tileSize,
    getCell(r, c) {
      if (!loaded.has(`${Math.floor(r / tileSize)}:${Math.floor(c / tileSize)}`)) return null;
      const ch = picture[r]?.[c] ?? ".";
      return { digit: digit(r, c), tremor: ch === "#" || ch === "r" ? 90 : 10, bin: ch === "r" ? "W" : "." };
    },
    async ensureTile(tr, tc) {
      requested.push(`${tr}:${tc}`);
      loaded.add(`${tr}:${tc}`);
    },
  };
  return { src, requested };
}

const ORDER: BinCode[] = ["DR", "WO", "MA", "FC"];
const rules = (over: Partial<GroupRules> = {}): GroupRules => ({
  tremorThreshold: 70,
  connectivity: 8,
  minGroupSize: 2,
  maxGroupSize: 10,
  binning: { strategy: "DIGIT_SUM_MOD", order: ORDER },
  ...over,
});

test("conectividad 8 une diagonales; conectividad 4 no", async () => {
  const picture = ["#...", ".#..", "....", "...."];
  const eight = await collectGroup(makeSource(picture, 4).src, rules({ connectivity: 8, minGroupSize: 1 }), { r: 0, c: 0 });
  assert.equal(eight.size, 2);
  const four = await collectGroup(makeSource(picture, 4).src, rules({ connectivity: 4, minGroupSize: 1 }), { r: 0, c: 0 });
  assert.equal(four.size, 1);
});

test("el grupo cruza bloques y pide los que faltan", async () => {
  const picture = ["....####....", "............"];
  const { src, requested } = makeSource(picture, 4);
  const group = await collectGroup(src, rules({ connectivity: 4, minGroupSize: 1 }), { r: 0, c: 4 });
  assert.equal(group.size, 4);
  assert.deepEqual(new Set(requested), new Set(["0:1", "0:0", "0:2"]));
});

test("bloques del borde más chicos (10x10 con tileSize 4)", async () => {
  const picture = [
    "..........",
    "..........",
    "..........",
    "..........",
    "..........",
    "..........",
    "..........",
    "..........",
    "........##",
    "........##",
  ];
  const { src } = makeSource(picture, 4);
  const group = await collectGroup(src, rules({ connectivity: 4, minGroupSize: 1 }), { r: 9, c: 9 });
  assert.equal(group.size, 4);
  assert.equal(group.noise, false);
});

test("ruido por mínimo", async () => {
  const group = await collectGroup(makeSource(["#...", "...."], 4).src, rules({ minGroupSize: 3 }), { r: 0, c: 0 });
  assert.equal(group.noise, true);
  assert.equal(group.bin, null);
  assert.equal(group.size, 1);
});

test("ruido por máximo: corta en maxGroupSize + 1", async () => {
  const picture = ["############"];
  const group = await collectGroup(makeSource(picture, 4).src, rules({ connectivity: 4, maxGroupSize: 5 }), { r: 0, c: 0 });
  assert.equal(group.noise, true);
  assert.equal(group.truncated, true);
  assert.equal(group.size, 6);
  assert.equal(group.bin, null);
});

test("una celda que no da miedo no forma grupo", async () => {
  const group = await collectGroup(makeSource(["#.#"], 4).src, rules(), { r: 0, c: 1 });
  assert.equal(group.size, 0);
  assert.equal(group.noise, false);
});

test("excluye celdas ya refinadas", async () => {
  const group = await collectGroup(makeSource(["##r##"], 5).src, rules({ connectivity: 4, minGroupSize: 1 }), { r: 0, c: 0 });
  assert.equal(group.size, 2);
  const onRefined = await collectGroup(makeSource(["##r##"], 5).src, rules({ minGroupSize: 1 }), { r: 0, c: 2 });
  assert.equal(onRefined.size, 0);
});

test("DIGIT_SUM_MOD usa la suma % 4 y order[índice]", () => {
  // suma 1+2+4 = 7 -> 7 % 4 = 3 -> order[3]
  assert.equal(binForDigits(rules(), [1, 2, 4]), ORDER[3]);
  // suma 8 -> 0 -> order[0]
  assert.equal(binForDigits(rules(), [3, 5]), ORDER[0]);
});

test("MAX_DIGIT_MOD usa el dígito máximo % 4", () => {
  const maxRules = rules({ binning: { strategy: "MAX_DIGIT_MOD", order: ORDER } });
  // máximo 9 -> 9 % 4 = 1 -> order[1]
  assert.equal(binForDigits(maxRules, [1, 9, 2]), ORDER[1]);
  // máximo 8 -> 0
  assert.equal(binForDigits(maxRules, [8, 1]), ORDER[0]);
});

test("las dos estrategias pueden dar cajas distintas para el mismo grupo", async () => {
  const picture = ["###"];
  const digit = (_r: number, c: number) => [1, 2, 4][c] ?? 0; // suma 7 (->3), máximo 4 (->0)
  const bySum = await collectGroup(makeSource(picture, 3, digit).src, rules({ minGroupSize: 1 }), { r: 0, c: 0 });
  const byMax = await collectGroup(
    makeSource(picture, 3, digit).src,
    rules({ minGroupSize: 1, binning: { strategy: "MAX_DIGIT_MOD", order: ORDER } }),
    { r: 0, c: 0 },
  );
  assert.equal(bySum.bin, ORDER[3]);
  assert.equal(byMax.bin, ORDER[0]);
});

test("una estrategia desconocida es un error, nunca se adivina", async () => {
  assert.throws(
    () => binForDigits(rules({ binning: { strategy: "OTRA", order: ORDER } }), [1]),
    UnknownStrategyError,
  );
  await assert.rejects(
    collectGroup(makeSource(["##"], 2).src, rules({ minGroupSize: 1, binning: { strategy: "OTRA", order: ORDER } }), { r: 0, c: 0 }),
    UnknownStrategyError,
  );
});
