import { describe, expect, it } from "vite-plus/test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { boundedSessionEntries } from "./session-metadata";

describe("bounded session results", () => {
  it("accepts only validated empty spans", () => {
    const manager = SessionManager.inMemory();
    const id = manager.appendMessage({ role: "user", content: "start", timestamp: 1 });
    expect(boundedSessionEntries(manager.getEntries(), null, null)).toEqual([]);
    expect(boundedSessionEntries(manager.getEntries(), id, id)).toEqual([]);
    expect(() => boundedSessionEntries(manager.getEntries(), id, null)).toThrow("ancestor");
    expect(() => boundedSessionEntries(manager.getEntries(), "missing", "missing")).toThrow(
      "Missing",
    );
  });
  it("includes the referenced end and excludes the referenced start", () => {
    const manager = SessionManager.inMemory();
    const start = manager.appendMessage({ role: "user", content: "start", timestamp: 1 });
    const end = manager.appendMessage({ role: "user", content: "end", timestamp: 2 });
    expect(
      boundedSessionEntries(manager.getEntries(), start, end).map((entry) => entry.id),
    ).toEqual([end]);
    expect(boundedSessionEntries(manager.getEntries(), null, end).map((entry) => entry.id)).toEqual(
      [start, end],
    );
  });
});
