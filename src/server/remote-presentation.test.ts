import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import type {
  SentFileDescriptor,
  SessionState,
  ActiveToolRun,
  QueuedPrompt,
  UiAssistantMessage,
  UiMessage,
} from "../shared/types";
import { exportNodePresentation, nodeSessionEvent } from "./remote-presentation";
import type { NodeAssistantMessage } from "../shared/node-api";

function reset(
  messages: UiMessage[],
  activeTools: ActiveToolRun[] = [],
  queuedPrompts?: QueuedPrompt[],
) {
  const state: SessionState = {
    id: "7",
    sessionId: "7",
    workspaceId: "work",
    cwd: "/projects/work",
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    isStreaming: true,
    pendingMessageCount: 0,
    updatedAt: 0,
    queuedPrompts,
    contextTokens: null,
    contextWindow: null,
    contextPercent: null,
    totalMessageCount: messages.length,
    hasMoreMessages: false,
    activeTools,
    messages,
  };
  return { type: "reset" as const, state };
}

function file(name: string): SentFileDescriptor {
  return {
    id: name,
    name,
    size: 9,
    kind: "file",
    mimeType: "text/plain",
    downloadUrl: `/api/sent-files/work/7/call/${name}`,
    storedPath: `/private/files/${name}`,
  };
}

const selected = file("selected");
const draft = file("private-draft.txt");
const previewCapability = "https://local.example/sites/private-capability";
const uploadMarkup =
  '<file name="private-draft.txt" mimeType="text/plain" size="5" path="/private/upload" url="/api/uploads/7/batch/private-draft.txt" artifactRef="file:secret-id"></file>';
const localOnly = {
  fileChanges: [{ path: "/private/edited", patch: "private patch" }],
  sites: [
    { kind: "site" as const, id: "site", name: "site", url: "/sites/private", public: false },
    {
      kind: "browser" as const,
      id: "browser",
      name: "browser",
      url: "/browser/private",
      public: false as const,
      browserId: "live-browser",
    },
  ],
};

test("session events project only explicit selected attachments and strip local paths", () => {
  const assistant: UiAssistantMessage = {
    id: "1",
    role: "assistant",
    timestamp: 0,
    turnPhase: "final",
    blocks: [{ type: "text", text: "Ready" }],
    ...localOnly,
    sentFiles: [selected],
  };
  const historical = { ...assistant, id: "2", historicalPresentation: true as const };
  const event = reset([assistant, historical]);
  const wire = nodeSessionEvent(event);
  const [explicit, archived] = (wire as { state: { messages: NodeAssistantMessage[] } }).state
    .messages;
  expect(explicit).toHaveProperty("presentation.sentFiles.0.name", "selected");
  expect(explicit).not.toHaveProperty("sentFiles");
  expect(archived).not.toHaveProperty("presentation.sentFiles");
  expect(JSON.stringify(wire)).not.toMatch(/\/private|browser|patch/);

  const oldWire = nodeSessionEvent(event, true);
  expect(
    (oldWire as { state: { messages: NodeAssistantMessage[] } }).state.messages[0],
  ).not.toHaveProperty("presentation.sentFiles");
});

test("history drops inventory and local-only effects even inside codemode results", () => {
  const messages: UiMessage[] = [
    {
      role: "toolResult",
      id: "1",
      timestamp: 0,
      toolName: "codemode",
      toolCallId: "call",
      blocks: [
        { type: "attachment", file: draft },
        {
          type: "text",
          text: `{"ref":"file:draft123","name":"private-draft.txt"}\n${previewCapability}`,
        },
      ],
      isError: false,
      details: {
        ...localOnly,
        sentFiles: [draft],
        calls: [
          {
            id: "nested",
            name: "import_files",
            args: '{"path":"private-draft.txt"}',
            status: "ok",
            details: { sentFiles: [draft] },
          },
          {
            id: "preview",
            name: "sites",
            args: JSON.stringify({ previewUrl: previewCapability }),
            status: "ok",
          },
        ],
      },
    },
    {
      role: "custom",
      id: "2",
      customType: "batty.remote-report",
      timestamp: 0,
      text: "Report",
      data: {
        assignment: { requestId: "r", grantId: "g" },
        assignmentId: "8",
        text: "Report",
        artifacts: { sentFiles: [draft] },
        presentation: { sentFiles: [selected], ...localOnly },
      },
    },
    {
      role: "custom",
      id: "3",
      customType: "batty-runtime-notice:subagent",
      timestamp: 0,
      text: "Assignment",
      data: {
        inputFiles: [file("selected-inbound")],
        runtimeResultArtifacts: { sentFiles: [draft] },
      },
    },
    {
      role: "user",
      id: "4",
      timestamp: 0,
      blocks: [
        { type: "attachment", file: draft },
        { type: "image", mimeType: "image/png", data: "draft image bytes" },
      ],
    },
    {
      role: "assistant",
      id: "5",
      timestamp: 0,
      turnPhase: "intermediate",
      blocks: [
        { type: "toolCall", id: "sites", name: "sites", arguments: { url: previewCapability } },
        {
          type: "toolCall",
          id: "report",
          name: "subagent",
          arguments: {
            action: "report",
            prompt: "finished",
            artifactRefs: ["site:site-123"],
            browserId: "live-browser",
          },
        },
      ],
    },
  ];
  const event = nodeSessionEvent(
    reset(
      messages,
      [
        {
          toolCallId: "screenshot",
          toolName: "browser",
          args: { action: "screenshot", url: previewCapability },
          blocks: [
            { type: "image", mimeType: "image/png", data: "draft screenshot bytes" },
            { type: "text", text: previewCapability },
          ],
          status: "success",
          isError: false,
        },
      ],
      [{ kind: "steer", index: 0, text: `Use this file\n${uploadMarkup}` }],
    ),
  );
  const json = JSON.stringify(event);
  expect(json).not.toMatch(
    /draft|\/private|live-browser|patch|runtimeResultArtifacts|private-capability|site-123/,
  );
  expect(event).toHaveProperty("state.queuedPrompts.0.text", "Use this file");
  expect(event).toMatchObject({
    state: {
      messages: [
        {
          blocks: [],
          details: {
            calls: [
              { name: "import_files", status: "ok", args: "" },
              { name: "sites", status: "ok", args: "" },
            ],
          },
        },
        { data: { presentation: { sentFiles: [{ name: "selected" }] } } },
        { data: { inputFiles: [{ name: "selected-inbound" }] } },
        { blocks: [] },
        {
          blocks: [
            { type: "toolCall", name: "sites", arguments: {} },
            {
              type: "toolCall",
              name: "subagent",
              arguments: { action: "report", prompt: "finished" },
            },
          ],
        },
      ],
      activeTools: [{ toolName: "browser", args: {}, blocks: [] }],
    },
  });
});

test("incremental queued prompts strip application-generated upload identities", () => {
  const {
    messages: _messages,
    activeTools: _tools,
    hasMoreMessages: _more,
    ...state
  } = reset(
    [],
    [],
    [{ kind: "followUp", index: 0, text: `Use this upload\n${uploadMarkup}` }],
  ).state;
  const event = nodeSessionEvent({ type: "state", state });
  expect(event).toHaveProperty("state.queuedPrompts.0.text", "Use this upload");
  expect(JSON.stringify(event)).not.toContain("secret-id");
});

test("selected upload snapshots survive source removal and export failures spare other selections", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "batty-remote-upload-"));
  const config = {
    baseUrl: "/batty" as const,
    sentFilesDir: path.join(root, "sent"),
    uploadsDir: path.join(root, "in"),
  };
  const source = path.join(config.uploadsDir, "7", "batch", "input.txt");
  try {
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "uploaded bytes");
    const uploaded = {
      ...file("Original upload.txt"),
      id: "upload",
      downloadUrl: "/batty/api/uploads/7/batch/input.txt?download=1",
    };
    const missing = {
      ...file("Missing file.txt"),
      id: "missing",
      downloadUrl: "/batty/api/uploads/7/batch/missing.txt",
    };
    const selected = { sentFiles: [uploaded, missing] };
    const first = await exportNodePresentation(config, selected);
    expect(first).toMatchObject({
      sentFiles: [
        {
          name: "Original upload.txt",
          downloadUrl: expect.stringContaining("/batty/api/sent-files/node-exports/"),
        },
      ],
      importErrors: ["Missing file.txt: failed to export selected file (ENOENT)"],
    });
    expect(JSON.stringify(first)).not.toContain(root);
    await unlink(source);
    expect(await exportNodePresentation(config, selected)).toEqual(first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
