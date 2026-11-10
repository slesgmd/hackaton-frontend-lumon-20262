import assert from "node:assert/strict";
import { test } from "node:test";
import { clearRefinerStore, isNewer, knownVersion, reconcile, reconcileAll } from "../src/lib/refinerStore.ts";

const refiner = (id: number, version: number, title = "t") => ({
  id,
  fullName: "A",
  department: { id: 1, code: "X", name: "X" },
  title,
  extension: "123",
  bio: "",
  profileUrl: null,
  badge: null,
  version,
  updatedAt: "2026-01-01T00:00:00Z",
});

test("una versión vieja nunca pisa a una nueva (stream o HTTP)", () => {
  clearRefinerStore();
  reconcile(refiner(7, 5, "nueva"));
  const stale = reconcile(refiner(7, 3, "vieja"));
  assert.equal(stale.version, 5);
  assert.equal(stale.title, "nueva");
  assert.equal(knownVersion(7), 5);
});

test("isNewer exige una versión estrictamente mayor", () => {
  clearRefinerStore();
  reconcile(refiner(1, 4));
  assert.equal(isNewer(1, 4), false);
  assert.equal(isNewer(1, 3), false);
  assert.equal(isNewer(1, 5), true);
  assert.equal(isNewer(2, 1), true);
});

test("reconcileAll conserva la versión más nueva por expediente", () => {
  clearRefinerStore();
  reconcile(refiner(9, 8, "ocho"));
  const [a, b] = reconcileAll([refiner(9, 6, "seis"), refiner(10, 1, "uno")]);
  assert.equal(a?.title, "ocho");
  assert.equal(b?.title, "uno");
});
