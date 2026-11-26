import { expect, test } from "vite-plus/test";
import { normalizeMessage } from "./pi-state";
import { decodeSiteAttachmentDescriptor } from "./site-attachments";
import { encodeRuntimeNotice } from "./runtime-notices";

const stored = [
  { id: "site", name: "Gallery", url: "/sites/site/", public: false },
  {
    id: "browser-live",
    browserId: "live",
    name: "Cloud browser",
    url: "/api/cloud-browser/live/state",
    public: false,
  },
];

test("stored site and browser descriptors project independently from the original links", () => {
  const before = JSON.stringify(stored);
  const sites = stored.map(decodeSiteAttachmentDescriptor);
  const battyPresentation = { sites, historical: true };
  const message = normalizeMessage(
    { role: "assistant", content: [], timestamp: 1, battyPresentation } as never,
    0,
  );
  expect(message).toMatchObject({ role: "assistant", sites, historicalPresentation: true });
  const notice = normalizeMessage(
    {
      role: "user",
      timestamp: 1,
      content: encodeRuntimeNotice({
        kind: "subagent",
        text: "Found",
        data: { runtimePresentation: battyPresentation },
      }),
    } as never,
    0,
  );
  expect(notice).toMatchObject({
    role: "custom",
    data: { runtimePresentation: battyPresentation },
  });
  expect(JSON.stringify(stored)).toBe(before);
});
