import { describe, expect, it } from "vite-plus/test";
import {
  buildToolStateLookup,
  buildTranscriptMessages,
  toolStatesForMessage,
} from "@/client/lib/transcript";
import { easyModeMessage } from "@/client/lib/easy-mode";
import type { SessionState, UiContentBlock, UiMessage } from "@/shared/types";

const assistantMessage: Extract<UiMessage, { role: "assistant" }> = {
  id: "assistant-1",
  role: "assistant",
  turnPhase: "final",
  timestamp: 1,
  blocks: [
    { type: "text", text: "Running a command" },
    {
      type: "toolCall",
      id: "call-1",
      name: "bash",
      arguments: { command: "git status --short", timeout: 600 },
    },
  ],
};

const toolResultMessage: Extract<UiMessage, { role: "toolResult" }> = {
  id: "tool-1",
  role: "toolResult",
  timestamp: 2,
  toolCallId: "call-1",
  toolName: "bash",
  blocks: [{ type: "text", text: "M src/client/views/ChatView.vue" }],
  isError: false,
};

describe("transcript tool state merging", () => {
  it("hides referenced tool results and attaches the final result to the tool call", () => {
    const messages: SessionState["messages"] = [assistantMessage, toolResultMessage];
    const lookup = buildToolStateLookup(messages, []);
    const transcript = buildTranscriptMessages(messages, lookup);

    expect(transcript).toHaveLength(1);
    expect(transcript[0]?.message).toEqual(assistantMessage);
    expect(transcript[0]?.toolStatesByCallId.get("call-1")).toEqual({
      status: "success",
      resultBlocks: [{ type: "text", text: "M src/client/views/ChatView.vue" }],
      resultDetails: undefined,
    });
  });

  it("moves attachment-only assistant tool calls into the following assistant response", () => {
    const attachmentAssistant: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-attach",
      role: "assistant",
      turnPhase: "intermediate",
      timestamp: 3,
      blocks: [
        {
          type: "toolCall",
          id: "attach-1",
          name: "attach-files",
          arguments: { paths: ["report.txt"] },
        },
      ],
    };
    const attachmentResult: Extract<UiMessage, { role: "toolResult" }> = {
      id: "tool-attach",
      role: "toolResult",
      timestamp: 4,
      toolCallId: "attach-1",
      toolName: "attach-files",
      blocks: [{ type: "text", text: "Attached 1 file for the user." }],
      details: {
        sentFiles: [
          {
            id: "file-1",
            name: "report.txt",
            size: 42,
            mimeType: "text/plain",
            kind: "file",
            downloadUrl: "/api/sent-files/file-1?download=1",
          },
        ],
      },
      isError: false,
    };
    const finalAssistant: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-final",
      role: "assistant",
      turnPhase: "final",
      timestamp: 5,
      blocks: [{ type: "text", text: "Here is the report." }],
    };

    const messages: SessionState["messages"] = [
      attachmentAssistant,
      attachmentResult,
      finalAssistant,
    ];
    const lookup = buildToolStateLookup(messages, []);
    const transcript = buildTranscriptMessages(messages, lookup);

    expect(transcript).toHaveLength(1);
    const transcriptMessage = transcript[0]?.message as Extract<UiMessage, { role: "assistant" }>;
    expect(transcriptMessage.id).toBe("assistant-final");
    expect(transcriptMessage.blocks).toEqual([
      { type: "text", text: "Here is the report." },
      attachmentAssistant.blocks[0],
    ]);
    expect(transcript[0]?.toolStatesByCallId.get("attach-1")?.resultDetails).toEqual(
      attachmentResult.details,
    );
  });

  it("moves attachment tool calls with thinking into the following assistant response", () => {
    const attachmentAssistant: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-attach",
      role: "assistant",
      turnPhase: "intermediate",
      timestamp: 3,
      blocks: [
        { type: "thinking", thinking: "I should attach the latest image." },
        {
          type: "toolCall",
          id: "attach-1",
          name: "attach-files",
          arguments: { paths: ["webcam.jpg"] },
        },
      ],
    };
    const attachmentResult: Extract<UiMessage, { role: "toolResult" }> = {
      id: "tool-attach",
      role: "toolResult",
      timestamp: 4,
      toolCallId: "attach-1",
      toolName: "attach-files",
      blocks: [{ type: "text", text: "Attached 1 file for the user." }],
      details: {
        sentFiles: [
          {
            id: "file-1",
            name: "webcam.jpg",
            size: 42,
            mimeType: "image/jpeg",
            kind: "image",
            downloadUrl: "/api/sent-files/file-1?download=1",
            previewUrl: "/api/sent-files/file-1",
          },
        ],
      },
      isError: false,
    };
    const finalAssistant: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-final",
      role: "assistant",
      turnPhase: "final",
      timestamp: 5,
      blocks: [{ type: "text", text: "Here is the report." }],
    };

    const messages: SessionState["messages"] = [
      attachmentAssistant,
      attachmentResult,
      finalAssistant,
    ];
    const lookup = buildToolStateLookup(messages, []);
    const transcript = buildTranscriptMessages(messages, lookup);

    expect(transcript).toHaveLength(2);
    expect(transcript[0]?.message).toEqual({
      ...attachmentAssistant,
      blocks: [attachmentAssistant.blocks[0] as UiContentBlock],
    });
    const transcriptMessage = transcript[1]?.message as Extract<UiMessage, { role: "assistant" }>;
    expect(transcriptMessage.id).toBe("assistant-final");
    expect(transcriptMessage.blocks).toEqual([
      { type: "text", text: "Here is the report." },
      attachmentAssistant.blocks[1],
    ]);
  });

  it("uses a distinct message ID when thinking and its attachment carrier both remain", () => {
    const attachmentAssistant: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-attach",
      role: "assistant",
      turnPhase: "intermediate",
      timestamp: 3,
      blocks: [
        { type: "thinking", thinking: "Attaching the image." },
        {
          type: "toolCall",
          id: "attach-1",
          name: "attach-files",
          arguments: { paths: ["webcam.jpg"] },
        },
      ],
    };
    const attachmentResult: Extract<UiMessage, { role: "toolResult" }> = {
      id: "tool-attach",
      role: "toolResult",
      timestamp: 4,
      toolCallId: "attach-1",
      toolName: "attach-files",
      blocks: [{ type: "text", text: "Attached 1 file for the user." }],
      details: {
        sentFiles: [
          {
            id: "file-1",
            name: "webcam.jpg",
            size: 42,
            mimeType: "image/jpeg",
            kind: "image",
            downloadUrl: "/api/sent-files/file-1?download=1",
          },
        ],
      },
      isError: false,
    };

    const messages: SessionState["messages"] = [attachmentAssistant, attachmentResult];
    const lookup = buildToolStateLookup(messages, []);
    const transcript = buildTranscriptMessages(messages, lookup);

    expect(transcript.map((entry) => entry.message.id)).toEqual([
      "assistant-attach",
      "assistant-attach:attachments",
    ]);
    const thinkingMessage = transcript[0]!.message as Extract<UiMessage, { role: "assistant" }>;
    const attachmentMessage = transcript[1]!.message as Extract<UiMessage, { role: "assistant" }>;
    expect(thinkingMessage.blocks).toEqual([attachmentAssistant.blocks[0]]);
    expect(attachmentMessage.blocks).toEqual([attachmentAssistant.blocks[1]]);
  });

  it("preserves thinking-only assistant messages for expandable transcript details", () => {
    const thinkingAssistant: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-thinking",
      role: "assistant",
      turnPhase: "final",
      timestamp: 3,
      blocks: [{ type: "thinking", thinking: "Inspecting the setup." }],
    };

    const lookup = buildToolStateLookup([thinkingAssistant], []);
    const transcript = buildTranscriptMessages([thinkingAssistant], lookup);

    expect(transcript).toHaveLength(1);
    expect(transcript[0]?.message).toEqual(thinkingAssistant);
  });

  it("carries pending attachments across intermediary tool-call assistant messages", () => {
    const attachmentAssistant: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-attach",
      role: "assistant",
      turnPhase: "intermediate",
      timestamp: 3,
      blocks: [
        {
          type: "toolCall",
          id: "attach-1",
          name: "attach-files",
          arguments: { paths: ["webcam.jpg"] },
        },
        {
          type: "toolCall",
          id: "bash-0",
          name: "bash",
          arguments: { command: "date" },
        },
      ],
    };
    const attachmentResult: Extract<UiMessage, { role: "toolResult" }> = {
      id: "tool-attach",
      role: "toolResult",
      timestamp: 4,
      toolCallId: "attach-1",
      toolName: "attach-files",
      blocks: [{ type: "text", text: "Attached 1 file for the user." }],
      details: {
        sentFiles: [
          {
            id: "file-1",
            name: "webcam.jpg",
            size: 42,
            mimeType: "image/jpeg",
            kind: "image",
            downloadUrl: "/api/sent-files/file-1?download=1",
            previewUrl: "/api/sent-files/file-1",
          },
        ],
      },
      isError: false,
    };
    const firstResult: Extract<UiMessage, { role: "toolResult" }> = {
      id: "tool-first",
      role: "toolResult",
      timestamp: 5,
      toolCallId: "bash-0",
      toolName: "bash",
      blocks: [{ type: "text", text: "Tue Jun 9" }],
      isError: false,
    };
    const commitAssistant: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-commit",
      role: "assistant",
      turnPhase: "intermediate",
      timestamp: 6,
      blocks: [
        {
          type: "toolCall",
          id: "bash-1",
          name: "bash",
          arguments: { command: "git commit -am update" },
        },
      ],
    };
    const commitResult: Extract<UiMessage, { role: "toolResult" }> = {
      id: "tool-commit",
      role: "toolResult",
      timestamp: 7,
      toolCallId: "bash-1",
      toolName: "bash",
      blocks: [{ type: "text", text: "[main abc123] update" }],
      isError: false,
    };
    const finalAssistant: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-final",
      role: "assistant",
      turnPhase: "final",
      timestamp: 8,
      blocks: [{ type: "text", text: "Here is the image." }],
    };

    const messages: SessionState["messages"] = [
      attachmentAssistant,
      attachmentResult,
      firstResult,
      commitAssistant,
      commitResult,
      finalAssistant,
    ];
    const lookup = buildToolStateLookup(messages, []);
    const transcript = buildTranscriptMessages(messages, lookup);

    expect(transcript).toHaveLength(3);
    expect(transcript[0]?.message).toEqual({
      ...attachmentAssistant,
      blocks: [attachmentAssistant.blocks[1] as UiContentBlock],
    });
    expect(transcript[1]?.message).toEqual(commitAssistant);
    const finalTranscriptMessage = transcript[2]?.message as Extract<
      UiMessage,
      { role: "assistant" }
    >;
    expect(finalTranscriptMessage.blocks).toEqual([
      { type: "text", text: "Here is the image." },
      attachmentAssistant.blocks[0],
    ]);
  });

  it.each(["subagent", "codemode"])(
    "propagates attachments from a nonempty %s result to the parent reply",
    (toolName) => {
      const subagentAssistant: Extract<UiMessage, { role: "assistant" }> = {
        id: "assistant-subagent",
        role: "assistant",
        turnPhase: "intermediate",
        timestamp: 3,
        blocks: [
          {
            type: "toolCall",
            id: "subagent-1",
            name: toolName,
            arguments: { prompt: "Build the report" },
          },
        ],
      };
      const subagentResult: Extract<UiMessage, { role: "toolResult" }> = {
        id: "tool-subagent",
        role: "toolResult",
        timestamp: 4,
        toolCallId: "subagent-1",
        toolName,
        blocks: [{ type: "text", text: "Report complete." }],
        details: {
          sentFiles: [
            {
              id: "file-1",
              name: "report.csv",
              size: 42,
              mimeType: "text/csv",
              kind: "file",
              downloadUrl: "/api/sent-files/file-1?download=1",
            },
          ],
        },
        isError: false,
      };
      const finalAssistant: Extract<UiMessage, { role: "assistant" }> = {
        id: "assistant-final",
        role: "assistant",
        turnPhase: "final",
        timestamp: 5,
        blocks: [{ type: "text", text: "Here is the report." }],
      };

      const messages: SessionState["messages"] = [
        subagentAssistant,
        subagentResult,
        finalAssistant,
      ];
      const lookup = buildToolStateLookup(messages, []);
      const transcript = buildTranscriptMessages(messages, lookup);

      expect(transcript).toHaveLength(2);
      expect(transcript[0]?.message).toEqual(subagentAssistant);
      expect(transcript[0]?.toolStatesByCallId.get("subagent-1")?.resultBlocks).toEqual([
        { type: "text", text: "Report complete." },
      ]);
      expect(transcript[1]?.message).toEqual({
        ...finalAssistant,
        blocks: [
          ...finalAssistant.blocks,
          { type: "toolCall", id: "subagent-1", name: "attach-files", arguments: {} },
        ],
      });
      expect(transcript[1]?.toolStatesByCallId.get("subagent-1")?.resultDetails).toEqual(
        subagentResult.details,
      );
    },
  );

  it.each([
    ["files", false],
    ["sites", false],
    ["both", false],
    ["files", true],
    ["sites", true],
    ["both", true],
  ] as const)(
    "keeps codemode %s attachments in easy mode with and without a final reply (error=%s)",
    (artifacts, isError) => {
      const call: Extract<UiMessage, { role: "assistant" }> = {
        id: "codemode-call",
        role: "assistant",
        timestamp: 1,
        turnPhase: "intermediate",
        blocks: [{ type: "toolCall", id: "code-1", name: "codemode", arguments: {} }],
      };
      const result: Extract<UiMessage, { role: "toolResult" }> = {
        id: "codemode-result",
        role: "toolResult",
        timestamp: 2,
        toolCallId: "code-1",
        toolName: "codemode",
        blocks: [{ type: "text", text: "Nested tool output" }],
        isError,
        details: {
          sentFiles:
            artifacts === "sites"
              ? []
              : [
                  {
                    id: "image-1",
                    name: "photo.jpg",
                    size: 42,
                    mimeType: "image/jpeg",
                    kind: "image",
                    downloadUrl: "/photo.jpg",
                  },
                ],
          sites:
            artifacts === "files"
              ? []
              : [{ id: "site-1", name: "Report", url: "/sites/site-1", public: true }],
        },
      };
      const final: Extract<UiMessage, { role: "assistant" }> = {
        id: "final",
        role: "assistant",
        timestamp: 3,
        turnPhase: "final",
        blocks: [{ type: "text", text: "Here you go." }],
      };

      const artifactOnlyFinal: Extract<UiMessage, { role: "assistant" }> = {
        ...final,
        blocks: [],
        sentFiles: result.details!.sentFiles as Extract<
          UiMessage,
          { role: "assistant" }
        >["sentFiles"],
        sites: result.details!.sites as Extract<UiMessage, { role: "assistant" }>["sites"],
      };
      for (const messages of [
        [call, result, final],
        [call, result],
        [result, final],
        [call, result, artifactOnlyFinal],
      ]) {
        const lookup = buildToolStateLookup(messages, []);
        const transcript = buildTranscriptMessages(messages, lookup);
        expect(transcript).toHaveLength(messages[0] === call ? 2 : 1);
        if (messages[0] === call) expect(transcript[0]?.message).toEqual(call);
        const entry = transcript.at(-1)!;
        const easy = easyModeMessage(entry.message, entry.toolStatesByCallId);
        expect(easy?.role).toBe("assistant");
        expect(easy && "blocks" in easy ? easy.blocks : []).toContainEqual({
          type: "toolCall",
          id: "code-1",
          name: artifacts === "sites" ? "sites" : "attach-files",
          arguments: {},
        });
        expect(entry.toolStatesByCallId.get("code-1")?.resultDetails).toEqual(result.details);
      }
    },
  );

  it.each(["files", "sites"])("keeps an artifact-only reply with promoted %s", (kind) => {
    const message: Extract<UiMessage, { role: "assistant" }> = {
      id: "artifacts",
      role: "assistant",
      timestamp: 1,
      turnPhase: "final",
      blocks: [],
      sentFiles:
        kind === "files"
          ? [
              {
                id: "file-1",
                name: "report.txt",
                size: 42,
                mimeType: "text/plain",
                kind: "file",
                downloadUrl: "/report.txt",
              },
            ]
          : [],
      sites:
        kind === "sites"
          ? [{ id: "site-1", name: "Report", url: "/sites/site-1", public: true }]
          : [],
    };
    const transcript = buildTranscriptMessages([message], buildToolStateLookup([message], []));
    expect(transcript).toHaveLength(1);
    expect(easyModeMessage(transcript[0]!.message)).toEqual(message);
  });

  it("moves standalone attachment tool results into the following assistant response", () => {
    const attachmentResult: Extract<UiMessage, { role: "toolResult" }> = {
      id: "tool-attach",
      role: "toolResult",
      timestamp: 4,
      toolCallId: "attach-1",
      toolName: "attach-files",
      blocks: [{ type: "text", text: "Attached 1 file for the user." }],
      details: {
        sentFiles: [
          {
            id: "file-1",
            name: "report.txt",
            size: 42,
            mimeType: "text/plain",
            kind: "file",
            downloadUrl: "/api/sent-files/file-1?download=1",
          },
        ],
      },
      isError: false,
    };
    const finalAssistant: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-final",
      role: "assistant",
      turnPhase: "final",
      timestamp: 5,
      blocks: [{ type: "text", text: "Here is the report." }],
    };

    const messages: SessionState["messages"] = [attachmentResult, finalAssistant];
    const lookup = buildToolStateLookup(messages, []);
    const transcript = buildTranscriptMessages(messages, lookup);

    const transcriptMessage = transcript[0]?.message as Extract<UiMessage, { role: "assistant" }>;
    expect(transcript).toHaveLength(1);
    expect(transcriptMessage.id).toBe("assistant-final");
    expect(transcriptMessage.blocks).toEqual([
      { type: "text", text: "Here is the report." },
      { type: "toolCall", id: "attach-1", name: "attach-files", arguments: {} },
    ]);
    expect(transcript[0]?.toolStatesByCallId.get("attach-1")?.resultDetails).toEqual(
      attachmentResult.details,
    );
  });

  it("moves shared sites into the following assistant response", () => {
    const siteResult: Extract<UiMessage, { role: "toolResult" }> = {
      id: "tool-site",
      role: "toolResult",
      timestamp: 4,
      toolCallId: "site-1",
      toolName: "sites",
      blocks: [{ type: "text", text: "Shared site." }],
      details: {
        sites: [
          { id: "published-1", name: "Dashboard", url: "/sites/published-1/", public: false },
        ],
      },
      isError: false,
    };
    const finalAssistant: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-final",
      role: "assistant",
      turnPhase: "final",
      timestamp: 5,
      blocks: [{ type: "text", text: "Dashboard ready." }],
    };

    const messages: SessionState["messages"] = [siteResult, finalAssistant];
    const lookup = buildToolStateLookup(messages, []);
    const transcript = buildTranscriptMessages(messages, lookup);
    const rendered = transcript[0]!.message as Extract<UiMessage, { role: "assistant" }>;
    expect(rendered.blocks).toEqual([
      { type: "text", text: "Dashboard ready." },
      { type: "toolCall", id: "site-1", name: "sites", arguments: {} },
    ]);
  });

  it("keeps a settled empty assistant error for the red error bubble", () => {
    const errorAssistant: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-error",
      role: "assistant",
      turnPhase: "final",
      timestamp: 3,
      blocks: [],
      stopReason: "error",
      errorMessage: "Too many concurrent requests",
    };
    const messages: SessionState["messages"] = [assistantMessage, errorAssistant];
    const lookup = buildToolStateLookup(messages, []);

    const transcript = buildTranscriptMessages(messages, lookup);

    expect(transcript.map((entry) => entry.message)).toEqual([assistantMessage, errorAssistant]);
  });

  it("hides failed attempts superseded by a later assistant response", () => {
    const failedAttempt: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-error",
      role: "assistant",
      turnPhase: "final",
      timestamp: 3,
      blocks: [],
      stopReason: "error",
      errorMessage: "Service Unavailable",
    };
    const recoveredAssistant: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-recovered",
      role: "assistant",
      turnPhase: "final",
      timestamp: 4,
      blocks: [{ type: "text", text: "Recovered" }],
    };
    const messages: SessionState["messages"] = [failedAttempt, recoveredAssistant];
    const lookup = buildToolStateLookup(messages, []);

    const transcript = buildTranscriptMessages(messages, lookup);

    expect(transcript.map((entry) => entry.message)).toEqual([recoveredAssistant]);
  });

  it("hides the latest assistant error until the running request settles", () => {
    const historicalError: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-old-error",
      role: "assistant",
      turnPhase: "final",
      timestamp: 3,
      blocks: [],
      stopReason: "error",
      errorMessage: "Earlier failure",
    };
    const nextUser: Extract<UiMessage, { role: "user" }> = {
      id: "user-retry",
      role: "user",
      timestamp: 4,
      blocks: [{ type: "text", text: "Retry" }],
    };
    const activeError: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-active-error",
      role: "assistant",
      turnPhase: "final",
      timestamp: 5,
      blocks: [],
      stopReason: "error",
      errorMessage: "Temporary failure",
    };
    const messages: SessionState["messages"] = [historicalError, nextUser, activeError];
    const lookup = buildToolStateLookup(messages, []);

    const transcript = buildTranscriptMessages(messages, lookup, true);

    expect(transcript.map((entry) => entry.message)).toEqual([historicalError, nextUser]);
  });

  it("uses active tool output while a tool has not persisted a result", () => {
    const messages: SessionState["messages"] = [assistantMessage];
    const lookup = buildToolStateLookup(messages, [
      {
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "git status --short", timeout: 600 },
        blocks: [{ type: "text", text: "still streaming" }],
        status: "running",
        isError: false,
      },
    ]);

    expect(toolStatesForMessage(assistantMessage, lookup.toolStatesByCallId).get("call-1")).toEqual(
      {
        status: "running",
        resultBlocks: [{ type: "text", text: "still streaming" }],
        resultDetails: undefined,
      },
    );
  });

  it("uses authoritative native active output when a historical call ID repeats", () => {
    const messages: SessionState["messages"] = [assistantMessage, toolResultMessage];
    const lookup = buildToolStateLookup(messages, [
      {
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "git status --short", timeout: 600 },
        blocks: [{ type: "text", text: "still streaming" }],
        status: "running",
        isError: false,
      },
    ]);

    expect(toolStatesForMessage(assistantMessage, lookup.toolStatesByCallId).get("call-1")).toEqual(
      {
        status: "running",
        resultBlocks: [{ type: "text", text: "still streaming" }],
        resultDetails: undefined,
      },
    );
  });
});
