import { createHash } from "node:crypto";
import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { artifactRefs, createAttachArtifactsTool, responseArtifacts } from "./artifact-forwarding";
import { normalizeMessage } from "./pi-state";
import { decodeSiteAttachmentDescriptor } from "./site-attachments";
import { encodeRuntimeNotice } from "./runtime-notices";
import type { AgentTurnArtifacts } from "./agent-turn-file-changes";

const storedSite = { id: "site", name: "Gallery", url: "/sites/site/", public: false };
const storedBrowser = {
  id: "browser-live",
  browserId: "live",
  name: "Cloud browser",
  url: "/api/cloud-browser/live/state",
  public: false,
};

test("immutable stored attachments keep refs, forwarding and their projected UI variant", async () => {
  const stored = [storedSite, storedBrowser];
  const before = JSON.stringify(stored);
  const sites = stored.map(decodeSiteAttachmentDescriptor);
  const refs = stored.map(
    (value, index) =>
      `${index === 0 ? "site" : "browser"}:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`,
  );
  expect(artifactRefs({ sites }).map((item) => item.ref)).toEqual(refs);
  const artifacts = { sites: stored } as unknown as AgentTurnArtifacts;
  const forwarded = await createAttachArtifactsTool().execute(
    { refs },
    {
      conversationId: 1,
      commit: async (fn: any) =>
        fn({
          scanEntries: async () => ({
            items: [{ model: [{ role: "toolResult", details: artifacts }] }],
          }),
        }),
    } as never,
    context,
  );
  expect((forwarded.details as unknown as AgentTurnArtifacts).sites).toEqual(sites);
  expect(
    responseArtifacts([
      { model: [{ role: "toolResult", toolName: "browser", details: { sites: [storedBrowser] } }] },
    ] as never),
  ).toEqual({ sites: [sites[1]] });

  const message = normalizeMessage(
    {
      role: "assistant",
      content: [],
      timestamp: 1,
      battySites: stored,
    } as never,
    0,
  );
  expect(message?.role === "assistant" && message.sites).toEqual(sites);
  const notice = normalizeMessage(
    {
      role: "user",
      timestamp: 1,
      content: encodeRuntimeNotice({
        kind: "subagent",
        text: "Found",
        data: { runtimeResultArtifacts: artifacts },
      }),
    } as never,
    0,
  );
  expect(notice?.role === "custom" && notice.data?.runtimeResultArtifacts).toEqual({ sites });
  expect(JSON.stringify(stored)).toBe(before);
});
