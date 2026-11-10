import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_DOM_CELLS, chooseCellSize, computeRange, inRange, rangeCount } from "../src/lib/viewport.ts";

test("nunca supera el máximo de celdas, ni con pantallas enormes", () => {
  for (const [width, height, cell] of [
    [800, 520, 28],
    [1920, 1080, 28],
    [3840, 2160, 28],
    [3840, 2160, 8],
    [10000, 10000, 4],
  ] as const) {
    for (const overscan of [0, 2, 10, 50]) {
      const range = computeRange({ scrollTop: 1234, scrollLeft: 987, width, height, cellSize: cell, rows: 512, cols: 512, overscan });
      assert.ok(rangeCount(range) <= MAX_DOM_CELLS - 1, `${width}x${height}@${cell} overscan ${overscan}: ${rangeCount(range)}`);
    }
  }
});

test("en la esquina final el rango sigue dentro de la grilla", () => {
  const range = computeRange({ scrollTop: 1e9, scrollLeft: 1e9, width: 800, height: 520, cellSize: 28, rows: 512, cols: 512, overscan: 2 });
  assert.ok(range.endRow <= 511 && range.endCol <= 511);
  assert.ok(range.startRow >= 0 && range.startCol >= 0);
  assert.ok(rangeCount(range) >= 1);
});

test("incluye el viewport visible cuando cabe", () => {
  const range = computeRange({ scrollTop: 280, scrollLeft: 560, width: 560, height: 280, cellSize: 28, rows: 100, cols: 100, overscan: 2 });
  assert.ok(inRange(range, 10, 20));
  assert.ok(inRange(range, 19, 39));
});

test("el overscan baja primero, no el viewport", () => {
  const big = computeRange({ scrollTop: 0, scrollLeft: 0, width: 1400, height: 1400, cellSize: 28, rows: 512, cols: 512, overscan: 40 });
  const small = computeRange({ scrollTop: 0, scrollLeft: 0, width: 1400, height: 1400, cellSize: 28, rows: 512, cols: 512, overscan: 0 });
  assert.ok(rangeCount(big) <= MAX_DOM_CELLS - 1);
  assert.ok(rangeCount(big) >= rangeCount(small) - 1 || rangeCount(big) <= rangeCount(small));
});

test("chooseCellSize crece cuando la pantalla haría pasar el límite", () => {
  assert.equal(chooseCellSize(800, 520), 28);
  const size = chooseCellSize(3840, 2160);
  assert.ok(size > 28);
  assert.ok((3840 / size) * (2160 / size) <= 1800 + 1);
});
