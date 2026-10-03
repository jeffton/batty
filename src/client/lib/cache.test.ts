import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { shallowReactive } from "vue";
import { get, set } from "idb-keyval";
import {
  cloneForCache,
  readCachedSession,
  trimSessionForCache,
  writeCachedSession,
} from "@/client/lib/cache";
import { makeSnapshot } from "./session-test-fixture";

vi.mock("idb-keyval", () => ({ get: vi.fn(), set: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe("native snapshot cache", () => {
  it("clones raw native documents, not computed presentation", async () => {
    const snapshot = makeSnapshot();
    snapshot.documents = {
      ...snapshot.documents,
      "pi.live": {
        run: { taskId: 1 as never, inputs: [] },
        tools: [{ callId: "call", name: "bash", status: "running", output: "partial" }],
      },
    };
    const reactiveSnapshot = shallowReactive(snapshot);
    expect(() => structuredClone(reactiveSnapshot)).toThrow();
    const cloned = cloneForCache(reactiveSnapshot);
    expect(structuredClone(cloned)).toEqual(snapshot);
    await writeCachedSession(reactiveSnapshot);
    const [key, cached] = vi.mocked(set).mock.calls[0]!;
    expect(key).toBe("batty:v4-native:session:session-a");
    expect(cached).toEqual(snapshot);
    expect(cached).not.toHaveProperty("activeTools");
    expect(cached).not.toHaveProperty("isStreaming");
    vi.mocked(get).mockResolvedValueOnce(cached);
    expect(await readCachedSession("session-a")).toEqual(snapshot);
    expect(get).toHaveBeenCalledExactlyOnceWith(key);
  });

  it("keeps only recent history while preserving documents and paging metadata", () => {
    const snapshot = makeSnapshot();
    snapshot.metadata.totalMessageCount = 120;
    snapshot.messages = Array.from({ length: 80 }, (_, index) => ({
      id: `user-${index}`,
      role: "user",
      timestamp: index,
      blocks: [{ type: "text", text: String(index) }],
    }));
    const trimmed = trimSessionForCache(snapshot);
    expect(trimmed.messages).toHaveLength(25);
    expect(trimmed.messages[0]?.id).toBe("user-55");
    expect(trimmed.metadata.totalMessageCount).toBe(120);
    expect(trimmed.metadata.hasMoreMessages).toBe(true);
    expect(trimmed.documents).toBe(snapshot.documents);
  });
});
