import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vite-plus/test";
import AgentTurnDiffPopover from "./AgentTurnDiffPopover.vue";

const pierre = vi.hoisted(() => ({
  create: vi.fn(),
  setup: vi.fn(),
  setItems: vi.fn(),
  cleanUp: vi.fn(),
  parsePatchFiles: vi.fn(() => [{ files: [{ hunks: [] }] }]),
}));

vi.mock("@pierre/diffs", () => ({
  CodeView: class {
    constructor(options: unknown) {
      pierre.create(options);
    }

    setup = pierre.setup;
    setItems = pierre.setItems;
    cleanUp = pierre.cleanUp;
  },
  parsePatchFiles: pierre.parsePatchFiles,
}));

describe("AgentTurnDiffPopover", () => {
  it("loads Pierre and renders the changed files when opened", async () => {
    const wrapper = mount(AgentTurnDiffPopover, {
      props: {
        popoverId: "changes-1",
        files: [
          {
            path: "/repo/src/value.ts",
            patch:
              "--- /repo/src/value.ts\n+++ /repo/src/value.ts\n@@ -1,1 +1,1 @@\n-export const value = 1;\n+export const value = 2;\n",
          },
        ],
      },
    });
    const toggle = new Event("toggle");
    Object.defineProperty(toggle, "newState", { value: "open" });
    wrapper.find("#changes-1").element.dispatchEvent(toggle);
    await flushPromises();

    expect(pierre.create).toHaveBeenCalledWith(
      expect.objectContaining({
        overflow: "wrap",
        unsafeCSS: expect.stringMatching(
          /--diffs-font-family: var\(--font-family-mono\)[\s\S]*--diffs-header-font-family: var\(--font-family-mono\)[\s\S]*font-weight: 500/,
        ),
      }),
    );
    const unsafeCSS = pierre.create.mock.calls[0]?.[0]?.unsafeCSS as string;
    expect(unsafeCSS).toContain("--diffs-computed-diff-line-bg: var(--color-diff-add-bg)");
    expect(unsafeCSS).toContain("--diffs-computed-diff-line-bg: var(--color-diff-remove-bg)");
    expect(unsafeCSS).toContain("background-color: var(--color-diff-inline)");
    expect(pierre.parsePatchFiles).toHaveBeenCalledWith(
      expect.stringContaining("-export const value = 1;\n+export const value = 2;"),
      "changes-1:0",
    );
    expect(pierre.setup).toHaveBeenCalledOnce();
    expect(pierre.setItems).toHaveBeenCalledWith([
      expect.objectContaining({ id: "/repo/src/value.ts", type: "diff" }),
    ]);

    wrapper.unmount();
    expect(pierre.cleanUp).toHaveBeenCalledOnce();
  });
});
