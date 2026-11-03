import type { SentFileDescriptor, SiteAttachmentDescriptor, UiMessage } from "@/shared/types";

export const video: SentFileDescriptor = {
  id: "timelapse",
  name: "Timelapse.mp4",
  mimeType: "video/mp4",
  kind: "video",
  size: 1733,
  downloadUrl: "/fixture-video.mp4",
  previewUrl: "/fixture-video.mp4",
};
export const image: SentFileDescriptor = {
  id: "image",
  name: "Frame.svg",
  mimeType: "image/svg+xml",
  kind: "image",
  size: 100,
  downloadUrl: "/fixture-image.svg",
  previewUrl: "/fixture-image.svg",
};
export const site: SiteAttachmentDescriptor = {
  id: "site",
  kind: "site",
  name: "Timelapse notes",
  public: false,
  url: "/fixture-site.html",
};
export const browserAttachment: SiteAttachmentDescriptor = {
  id: "browser",
  kind: "browser",
  name: "Shared browser",
  public: false,
  browserId: "fixture-browser",
  url: "/fixture-site.html",
};
export const changes = [{ path: "notes.md", patch: "@@ -1 +1 @@\n-old\n+new\n" }];

// Native codemode outputs can coincide with server-projected explicit forwards.
// Received child reports must never become implicit response attachments.
export function commentaryAttachments(): UiMessage[] {
  return [
    {
      id: "user",
      role: "user",
      timestamp: 1,
      blocks: [{ type: "text", text: "Create a timelapse" }],
    },
    {
      id: "tool-request",
      role: "assistant",
      timestamp: 2,
      turnPhase: "intermediate",
      blocks: [
        { type: "text", text: "I will prepare the video." },
        { type: "toolCall", id: "code", name: "codemode", arguments: {} },
      ],
    },
    {
      id: "tool-result",
      role: "toolResult",
      timestamp: 3,
      toolCallId: "code",
      toolName: "codemode",
      isError: false,
      blocks: [],
      details: {
        sentFiles: [video, image, { ...video, id: "child", name: "Unselected child.mp4" }],
        sites: [site],
        calls: [
          {
            id: "native",
            name: "attach_files",
            args: "{}",
            status: "ok",
            sentFiles: [video, image],
          },
          { id: "native-site", name: "sites", args: "{}", status: "ok", sites: [site] },
          {
            id: "child",
            name: "subagent",
            args: "{}",
            status: "ok",
            sentFiles: [{ ...video, id: "child", name: "Unselected child.mp4" }],
          },
          {
            id: "forward",
            name: "attach_artifacts",
            args: "{}",
            status: "ok",
            forwardedArtifacts: {
              sentFiles: [video],
              sites: [site, browserAttachment],
              fileChanges: changes,
            },
          },
        ],
      },
    },
    {
      id: "commentary",
      role: "assistant",
      timestamp: 4,
      turnPhase: "intermediate",
      stopReason: "toolUse",
      blocks: [
        { type: "text", text: "Here is the timelapse." },
        { type: "toolCall", id: "wait", name: "subagent", arguments: { action: "await" } },
      ],
      sentFiles: [video],
      sites: [site, browserAttachment],
      fileChanges: changes,
    },
    {
      id: "wait-result",
      role: "toolResult",
      timestamp: 5,
      toolCallId: "wait",
      toolName: "subagent",
      isError: false,
      blocks: [],
    },
    {
      id: "final",
      role: "assistant",
      timestamp: 6,
      turnPhase: "final",
      blocks: [{ type: "text", text: "The unrelated task is complete." }],
    },
  ];
}
