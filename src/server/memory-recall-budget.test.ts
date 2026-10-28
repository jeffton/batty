import { expect, test } from "vite-plus/test";
import { fitMemoryRecall } from "./memory-requests";

const block =
  "<memory-recall>\nHistorical sources\n<chat>\n1+1|user: first source\n2+1|talk: second source\n</chat>\n</memory-recall>";

test("recall budget drops complete source lines, omits an inadmissible block and preserves admitted prefixes", () => {
  expect(fitMemoryRecall(block, () => true)).toBe(block);
  expect(fitMemoryRecall(block, (text) => text.length <= 100)).toBe(
    "<memory-recall>\nHistorical sources\n<chat>\n1+1|user: first source\n</chat>\n</memory-recall>",
  );
  expect(fitMemoryRecall(block, (text) => text.length < 10)).toBe("");
});
