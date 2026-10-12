import { describe, expect, it, vi } from "vite-plus/test";
import { flushPromises, mount } from "@vue/test-utils";
import MessageComposer from "./MessageComposer.vue";
import { clearSessionDraft } from "@/client/lib/session-draft";

describe("file attachments", () => {
  function composer() {
    clearSessionDraft("attachment-test");
    clearSessionDraft("new-draft");
    return mount(MessageComposer, {
      props: {
        sessionKey: "attachment-test",
      },
      global: { stubs: { ComposerQueuedPrompts: true } },
    });
  }

  function file(name: string, content: string) {
    const value = new File([content], name, { type: "image/png" });
    const bytes = new TextEncoder().encode(content).buffer;
    Object.defineProperty(value, "arrayBuffer", { value: vi.fn().mockResolvedValue(bytes) });
    return value;
  }

  async function select(wrapper: ReturnType<typeof composer>, files: File[]) {
    const input = wrapper.get('input[type="file"]');
    Object.defineProperty(input.element, "files", { configurable: true, value: files });
    await input.trigger("change");
  }

  it("deduplicates content across overlapping selections, preserving different same-name files", async () => {
    const wrapper = composer();
    try {
      const first = file("image.png", "same pixels");
      let finish!: (value: ArrayBuffer) => void;
      vi.mocked(first.arrayBuffer).mockReturnValue(
        new Promise<ArrayBuffer>((resolve) => {
          finish = resolve;
        }),
      );
      await select(wrapper, [first, file("copy.png", "same pixels")]);
      await select(wrapper, [file("image.png", "same pixels"), file("image.png", "different")]);
      await wrapper.get("textarea").setValue("Screenshot");
      await wrapper.get('button[aria-label="Send prompt"]').trigger("click");
      expect(wrapper.emitted("submit")).toBeUndefined();
      finish(new TextEncoder().encode("same pixels").buffer);
      await vi.waitFor(() => expect(wrapper.findAll(".composer__chip")).toHaveLength(2));
      await wrapper.get('button[aria-label="Send prompt"]').trigger("click");
      const submitted = wrapper.emitted("submit")![0]![1] as File[];
      expect(submitted).toHaveLength(2);
      expect(await Promise.all(submitted.map((value) => value.arrayBuffer()))).toEqual([
        new TextEncoder().encode("same pixels").buffer,
        new TextEncoder().encode("different").buffer,
      ]);
    } finally {
      wrapper.unmount();
    }
  });

  it("shows file-read failures without attaching unreadable files", async () => {
    const wrapper = composer();
    try {
      const unreadable = file("broken.png", "broken");
      vi.mocked(unreadable.arrayBuffer).mockRejectedValue(new Error("File read failed"));
      await select(wrapper, [unreadable]);
      await flushPromises();
      expect(wrapper.text()).toContain("File read failed");
      expect(wrapper.findAll(".composer__chip")).toHaveLength(0);
    } finally {
      wrapper.unmount();
    }
  });

  it.each(["clear", "session change"])(
    "discards pending selections on %s without blocking new drafts",
    async (action) => {
      const wrapper = composer();
      try {
        const pending = file("image.png", "pixels");
        let finish!: (value: ArrayBuffer) => void;
        vi.mocked(pending.arrayBuffer).mockReturnValue(
          new Promise<ArrayBuffer>((resolve) => {
            finish = resolve;
          }),
        );
        await select(wrapper, [pending]);
        if (action === "clear") {
          wrapper.vm.clear();
        } else {
          await wrapper.setProps({ sessionKey: "new-draft" });
        }
        await wrapper.get("textarea").setValue("New draft");
        await wrapper.get('button[aria-label="Send prompt"]').trigger("click");
        expect(wrapper.emitted("submit")?.[0]).toEqual(["New draft", []]);
        finish(new TextEncoder().encode("pixels").buffer);
        await select(wrapper, [file("new.png", "new pixels")]);
        await vi.waitFor(() => expect(wrapper.findAll(".composer__chip")).toHaveLength(1));
        expect(wrapper.get(".composer__chip").text()).toBe("new.png ×");
      } finally {
        wrapper.unmount();
      }
    },
  );
  it("does not restore a failed submission over a pending new file selection", async () => {
    const wrapper = composer();
    try {
      const pending = file("new.png", "new pixels");
      let finish!: (value: ArrayBuffer) => void;
      vi.mocked(pending.arrayBuffer).mockReturnValue(
        new Promise<ArrayBuffer>((resolve) => {
          finish = resolve;
        }),
      );
      await select(wrapper, [pending]);
      wrapper.vm.restore("attachment-test", "Failed old message", []);
      expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("");
      finish(new TextEncoder().encode("new pixels").buffer);
      await vi.waitFor(() => expect(wrapper.findAll(".composer__chip")).toHaveLength(1));
      await wrapper.get('button[aria-label="Send prompt"]').trigger("click");
      expect(wrapper.emitted("submit")?.[0]).toEqual(["", [pending]]);
    } finally {
      wrapper.unmount();
    }
  });
});

describe("memory preparation", () => {
  it("shows preparation progress without blocking main prompts", async () => {
    const wrapper = mount(MessageComposer, {
      props: {
        compacting: false,
        memoryPending: 8,
        sessionKey: "main",
      },
      global: { stubs: { ComposerQueuedPrompts: true } },
    });
    try {
      // The initial session snapshot supplies this before any memory-status request.
      expect(wrapper.get('button[aria-label="Running tasks"]').text()).toBe("1 task");
      expect(wrapper.find(".streaming-stop-control").exists()).toBe(false);
      expect(wrapper.text()).not.toContain("Compacting");
      await wrapper.get("textarea").setValue("Queue this while memory is prepared");
      const send = wrapper.get('button[aria-label="Send prompt"]');
      expect(send.attributes("disabled")).toBeUndefined();
      await send.trigger("click");
      expect(wrapper.emitted("submit")?.[0]).toEqual(["Queue this while memory is prepared", []]);

      await wrapper.setProps({ memoryPending: 0, error: "Memory summarizer failed" });
      expect(wrapper.text()).toContain("Memory summarizer failed");
      expect(wrapper.text()).not.toContain("Preparing memory");
      expect(wrapper.text()).not.toContain("Compacting");

      await wrapper.setProps({ compacting: true, error: undefined });
      expect(wrapper.get('button[aria-label="Running tasks"]').text()).toBe("1 task");
      expect(wrapper.text()).not.toContain("Preparing memory");
    } finally {
      wrapper.unmount();
    }
  });
});
