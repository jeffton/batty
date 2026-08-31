import { shallowMount } from "@vue/test-utils";
import { nextTick } from "vue";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import MessageComposer from "./MessageComposer.vue";
import { readSessionDraft, writeSessionDraft } from "@/client/lib/session-draft";

const requiredProps = {
  modelPopoverId: "model-popover",
  modelPopoverAnchor: "--model-anchor",
  models: [],
  currentThinkingLevel: "medium",
  thinkingOptions: ["medium"],
  modelButtonLabel: "Model",
  thinkingButtonLabel: "Medium",
};

describe("MessageComposer", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("disables browser autofill without disabling writing assistance", () => {
    const wrapper = shallowMount(MessageComposer, {
      props: { ...requiredProps, sessionKey: "session-a" },
    });
    const textarea = wrapper.get("textarea");

    expect(textarea.attributes("autocomplete")).toBe("off");
    expect(textarea.attributes("autocorrect")).toBe("on");
    expect(textarea.attributes("spellcheck")).toBe("true");
  });

  it("restores a failed prompt only into its originating session", async () => {
    writeSessionDraft("session-b", "draft B");
    const wrapper = shallowMount(MessageComposer, {
      props: { ...requiredProps, sessionKey: "session-b" },
    });
    await nextTick();

    const restore = (
      wrapper.vm as unknown as {
        restore(sessionKey: string, text: string, files: File[]): void;
      }
    ).restore;
    restore("session-a", "failed A", [new File(["a"], "a.txt")]);
    await nextTick();

    expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("draft B");
    expect(readSessionDraft("session-b")).toBe("draft B");
    expect(readSessionDraft("session-a")).toBe("failed A");
    expect(wrapper.find(".composer__attachments").exists()).toBe(false);

    await wrapper.setProps({ sessionKey: "session-a" });
    await nextTick();
    expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("failed A");
    expect(wrapper.get(".composer__attachments").text()).toContain("a.txt");
  });

  it("does not replace newer composer input when an earlier prompt fails", async () => {
    const wrapper = shallowMount(MessageComposer, {
      props: { ...requiredProps, sessionKey: "session-a" },
    });
    const textarea = wrapper.get("textarea");
    await textarea.setValue("new input");

    const restore = (
      wrapper.vm as unknown as {
        restore(sessionKey: string, text: string, files: File[]): void;
      }
    ).restore;
    restore("session-a", "failed prompt", []);
    await nextTick();

    expect((textarea.element as HTMLTextAreaElement).value).toBe("new input");
  });
});
