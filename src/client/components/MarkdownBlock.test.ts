import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vite-plus/test";
import MarkdownBlock from "@/client/components/MarkdownBlock.vue";

describe("MarkdownBlock", () => {
  it("opens rendered links in a new browser context", () => {
    const wrapper = mount(MarkdownBlock, {
      props: {
        text: "Open [Batty](https://example.com).",
      },
    });

    const link = wrapper.get("a");
    expect(link.attributes("href")).toBe("https://example.com");
    expect(link.attributes("target")).toBe("_blank");
    expect(link.attributes("rel")).toBe("noopener noreferrer");
  });
});
