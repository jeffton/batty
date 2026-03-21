import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  clearSessionDraft,
  readSessionDraft,
  sessionDraftStorageKey,
  writeSessionDraft,
} from "@/client/lib/session-draft";

describe("session-draft", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("builds a stable per-session storage key", () => {
    expect(sessionDraftStorageKey("session/123")).toBe("batty:session-draft:session%2F123");
  });

  it("reads and writes session drafts", () => {
    writeSessionDraft("session-1", "draft message");

    expect(readSessionDraft("session-1")).toBe("draft message");
    expect(readSessionDraft("session-2")).toBe("");
  });

  it("clears drafts when asked", () => {
    writeSessionDraft("session-1", "draft message");
    clearSessionDraft("session-1");

    expect(readSessionDraft("session-1")).toBe("");
  });

  it("treats an empty draft as cleared", () => {
    writeSessionDraft("session-1", "");

    expect(window.localStorage.getItem(sessionDraftStorageKey("session-1"))).toBeNull();
  });
});
