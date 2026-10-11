import { expect, test } from "vite-plus/test";
import { fitView, utf8Bytes } from "./memory-view";

test("most-due sibling merge preserves a complete aligned cover and measures UTF8", () => {
  const parts = Array.from({ length: 8 }, (_, start) => ({ start, count: 1 }));
  const nodes = new Map(parts.map((part) => [`${part.start}+1`, "æ".repeat(10)]));
  for (let start = 0; start < 8; start += 2) nodes.set(`${start}+2`, "merged");
  const view = fitView(parts, 8, nodes, 150);
  expect(view[0]).toEqual({ start: 0, count: 2 });
  expect(view.reduce((sum, part) => sum + part.count, 0)).toBe(8);
  expect(parts).toHaveLength(8);
});

test("view batches trigger strictly above the limit and preserve the prefix between batches", () => {
  const parts = Array.from({ length: 8 }, (_, start) => ({ start, count: 1 }));
  const nodes = new Map(parts.map((part) => [`${part.start}+1`, "x".repeat(16_000)]));
  for (let count = 2; count <= 8; count *= 2)
    for (let start = 0; start < 8; start += count) nodes.set(`${start}+${count}`, "m".repeat(512));
  expect(fitView(parts, 8, nodes)).toEqual(parts); // Exactly 128,000 bytes.
  nodes.set("7+1", "x".repeat(16_001));
  const fitted = fitView(parts, 8, nodes);
  const bytes = fitted.reduce(
    (sum, part) => sum + utf8Bytes(nodes.get(`${part.start}+${part.count}`)!),
    0,
  );
  expect(bytes).toBeLessThanOrEqual(64_000);
  nodes.set("8+1", "next message");
  const appended = [...fitted, { start: 8, count: 1 }];
  expect(fitView(appended, 9, nodes)).toEqual(appended);
});

test("an unfinished batch resumes below the trigger when its parents become available", () => {
  const parts = Array.from({ length: 8 }, (_, start) => ({ start, count: 1 }));
  const nodes = new Map(parts.map((part) => [`${part.start}+1`, "x".repeat(20)]));
  nodes.set("0+2", "m");
  const batch = {};
  const partial = fitView(parts, 8, nodes, 150, batch);
  expect(partial).toHaveLength(7); // 121 bytes: below trigger, above 75-byte target.
  expect(batch).toEqual({ merging: true });
  // Persisted state survives a restart, without requiring the original parts.
  const resumedBatch = JSON.parse(JSON.stringify(batch));
  for (let start = 2; start < 8; start += 2) nodes.set(`${start}+2`, "m");
  const resumed = fitView(partial, 8, nodes, 150, resumedBatch);
  expect(
    resumed.reduce((sum, part) => sum + utf8Bytes(nodes.get(`${part.start}+${part.count}`)!), 0),
  ).toBeLessThanOrEqual(75);
  expect(resumedBatch.merging).toBe(false);
});

test("merge age is normalized by line size, with oldest-first ties", () => {
  const parts = [
    { start: 0, count: 4 },
    { start: 4, count: 4 },
    { start: 8, count: 4 },
    { start: 12, count: 1 },
    { start: 13, count: 1 },
  ];
  const nodes = new Map(parts.map((part) => [`${part.start}+${part.count}`, "x".repeat(40)]));
  nodes.set("0+8", "m");
  nodes.set("12+2", "m");
  // At T=16 both pairs are two line-sizes old; the older pair wins the tie.
  expect(fitView(parts, 16, nodes, 330, { merging: true })).toEqual([
    { start: 0, count: 8 },
    ...parts.slice(2),
  ]);
});
