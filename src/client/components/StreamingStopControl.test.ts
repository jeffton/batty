import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vite-plus/test";
import StreamingStopControl from "./StreamingStopControl.vue";

describe("StreamingStopControl", () => {
  it("shows compaction status before the spinner and stop button", () => {
    const wrapper = mount(StreamingStopControl, { props: { compacting: true } });
    const children = wrapper.get(".streaming-stop-control").element.children;

    expect(children[0]?.classList.contains("streaming-stop-control__status")).toBe(true);
    expect(children[0]?.textContent).toBe("Compacting");
    expect(children[1]?.classList.contains("streaming-stop-control__spinner")).toBe(true);
    expect(children[2]?.classList.contains("streaming-stop-control__button")).toBe(true);
  });

  it("hides compaction status during regular streaming", () => {
    const wrapper = mount(StreamingStopControl);

    expect(wrapper.find(".streaming-stop-control__status").exists()).toBe(false);
  });
});
