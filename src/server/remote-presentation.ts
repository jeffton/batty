import path from "node:path";
import type { AppConfig } from "./config";
import { NODE_EXPORTS_WORKSPACE, storeSentFiles } from "./send-files";
import type {
  NodeAssistantMessage,
  NodeFile,
  NodeMessage,
  NodePresentation,
  NodeSessionEvent,
} from "../shared/node-api";
import type {
  ActiveToolRun,
  QueuedPrompt,
  SentFileDescriptor,
  ServerEvent,
  ToolExecutionDetails,
  UiAssistantMessage,
  UiContentBlock,
  UiMessage,
} from "../shared/types";

type LocalPresentation = NodePresentation & { historical?: true };

function nodePresentation(presentation?: LocalPresentation): NodePresentation | undefined {
  if (!presentation || presentation.historical) return undefined;
  const { sentFiles, importErrors } = presentation;
  if (!sentFiles?.length && !importErrors?.length) return undefined;
  return { sentFiles: sentFiles?.map(nodeFile), importErrors };
}

type ExportConfig = Pick<AppConfig, "baseUrl" | "sentFilesDir" | "uploadsDir">;

const exportsInFlight = new Map<string, Promise<SentFileDescriptor>>();

async function exportFile(
  config: ExportConfig,
  file: SentFileDescriptor,
): Promise<SentFileDescriptor> {
  const url = new URL(file.downloadUrl, "http://batty.invalid");
  const parts = /\/api\/uploads\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (!parts) return nodeFile(file);
  const key = path.join(config.sentFilesDir, file.id);
  let pending = exportsInFlight.get(key);
  if (!pending) {
    pending = (async () => {
      const [sessionId, batchId, storedName] = parts.slice(1).map(decodeURIComponent) as [
        string,
        string,
        string,
      ];
      if (
        [sessionId, batchId, storedName].some(
          (part) => part === "." || part === ".." || /[/\\\0]/.test(part),
        )
      )
        throw new Error("Invalid selected upload identity");
      const [snapshot] = await storeSentFiles({
        rootDir: config.sentFilesDir,
        baseUrl: config.baseUrl,
        workspaceId: NODE_EXPORTS_WORKSPACE,
        sessionId,
        toolCallId: file.id,
        cwd: config.uploadsDir,
        paths: [path.join(config.uploadsDir, sessionId, batchId, storedName)],
        names: [file.name],
        reuseExisting: true,
      });
      return nodeFile(snapshot!);
    })();
    exportsInFlight.set(key, pending);
    void pending.finally(() => exportsInFlight.delete(key)).catch(() => {});
  }
  return pending;
}

export async function exportNodePresentation(
  config: ExportConfig,
  presentation?: LocalPresentation,
) {
  const selected = nodePresentation(presentation);
  if (!selected?.sentFiles?.length) return selected;
  const exports = await Promise.all(
    selected.sentFiles.map(async (file) => {
      try {
        return { file: await exportFile(config, file) };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return { error: `${file.name}: failed to export selected file${code ? ` (${code})` : ""}` };
      }
    }),
  );
  return nodePresentation({
    sentFiles: exports.flatMap((item) => (item.file ? [item.file] : [])),
    importErrors: [
      ...(selected.importErrors ?? []),
      ...exports.flatMap((item) => (item.error ? [item.error] : [])),
    ],
  });
}

function nodeFile(file: SentFileDescriptor): NodeFile {
  const { id, name, size, mimeType, kind, downloadUrl, previewUrl } = file;
  return { id, name, size, mimeType, kind, downloadUrl, previewUrl };
}

const localToolOutput = new Set([
  "import_files",
  "sites",
  "browser",
  "attach_files",
  "attach_artifacts",
]);

function nodeArgs(name: string, args: Record<string, unknown>) {
  if (localToolOutput.has(name) || name === "codemode") return {};
  if (name !== "subagent") return args;
  const { artifactRefs: _refs, browserId: _browser, files: _files, ...rest } = args;
  return rest;
}

function nodeBlocks(blocks: UiContentBlock[]): UiContentBlock[] {
  return blocks.flatMap((block): UiContentBlock[] => {
    if (block.type === "attachment" || block.type === "image") return [];
    if (block.type === "toolCall")
      return [{ ...block, arguments: nodeArgs(block.name, block.arguments) }];
    return [block];
  });
}

function stripFileMarkup(text: string) {
  return text
    .replace(
      /<file name="[^"]*" mimeType="[^"]*" size="\d+" path="[^"]*" url="[^"]*"(?: artifactRef="[^"]*")?><\/file>\n?/g,
      "",
    )
    .trimEnd();
}

function nodeQueuedPrompts(prompts?: QueuedPrompt[]) {
  return prompts?.map((prompt) => ({ ...prompt, text: stripFileMarkup(prompt.text) }));
}

function nodeAssistant(
  message: UiAssistantMessage & { presentation?: NodePresentation; historicalPresentation?: true },
  source: "local" | "wire" | "active",
): NodeAssistantMessage {
  const {
    fileChanges: _changes,
    sites: _sites,
    sentFiles,
    presentation,
    historicalPresentation,
    ...rest
  } = message;
  return {
    ...rest,
    blocks: nodeBlocks(message.blocks),
    presentation: nodePresentation(
      source === "wire"
        ? presentation
        : source === "local"
          ? { sentFiles, historical: historicalPresentation }
          : undefined,
    ),
  };
}

function nodeToolDetails(details?: ToolExecutionDetails): ToolExecutionDetails | undefined {
  if (!details?.calls) return undefined;
  return {
    calls: details.calls.map(({ id, name, args, status, durationMs, error, cost, subagent }) => ({
      id,
      name,
      args: localToolOutput.has(name) || name === "codemode" || name === "subagent" ? "" : args,
      status,
      durationMs,
      error: localToolOutput.has(name) ? undefined : error,
      cost,
      subagent,
    })),
  };
}

function localOutput(name: string, details: unknown) {
  return (
    localToolOutput.has(name) ||
    (name === "subagent" &&
      typeof details === "object" &&
      details !== null &&
      ("presentation" in details || "referencedArtifacts" in details))
  );
}

function nodeToolBlocks(tool: Pick<ActiveToolRun, "toolName" | "blocks" | "details">) {
  return localOutput(tool.toolName, tool.details) ||
    tool.details?.calls?.some((call) => localOutput(call.name, call.details))
    ? []
    : nodeBlocks(tool.blocks);
}

function nodeTool(tool: ActiveToolRun): ActiveToolRun {
  return {
    ...tool,
    args: nodeArgs(tool.toolName, tool.args),
    blocks: nodeToolBlocks(tool),
    details: nodeToolDetails(tool.details),
  };
}

function nodeMessage(message: UiMessage | NodeMessage, fromWire: boolean): NodeMessage {
  switch (message.role) {
    case "assistant":
      return nodeAssistant(message, fromWire ? "wire" : "local");
    case "user":
      return {
        ...message,
        blocks: nodeBlocks(message.blocks).map((block) =>
          block.type === "text" ? { ...block, text: stripFileMarkup(block.text) } : block,
        ),
      };
    case "toolResult":
      return {
        ...message,
        blocks: nodeToolBlocks(message),
        details: nodeToolDetails(message.details),
      };
    case "custom": {
      if (!message.data) return message;
      const {
        assignment,
        assignmentId,
        text,
        failed,
        presentation,
        runtimePresentation,
        runtimeNotice,
        subagent,
        cron,
        inputFiles,
      } = message.data;
      if (["batty.remote-report", "batty.remote-result"].includes(message.customType))
        return {
          ...message,
          data: {
            assignment,
            assignmentId,
            text,
            failed,
            presentation: nodePresentation(presentation as LocalPresentation | undefined),
          },
        };
      if (message.customType.startsWith("batty-runtime-notice:")) {
        const display = runtimeNotice as { text: string; markdown: string } | undefined;
        return {
          ...message,
          text: display
            ? [display.text, display.markdown].join("\n")
            : stripFileMarkup(message.text),
          data: {
            runtimeNotice,
            subagent,
            cron,
            ...(message.customType === "batty-runtime-notice:subagent" && Array.isArray(inputFiles)
              ? { inputFiles: inputFiles.map(nodeFile) }
              : {}),
            runtimePresentation: nodePresentation(
              runtimePresentation as LocalPresentation | undefined,
            ),
          },
        };
      }
      return { ...message, data: undefined };
    }
    default:
      return message;
  }
}

async function exportNodeMessage(config: ExportConfig, message: NodeMessage): Promise<NodeMessage> {
  if (message.role === "assistant") {
    return { ...message, presentation: await exportNodePresentation(config, message.presentation) };
  }
  if (message.role !== "custom" || !message.data) return message;
  const { presentation, runtimePresentation } = message.data;
  if (presentation)
    return {
      ...message,
      data: {
        ...message.data,
        presentation: await exportNodePresentation(config, presentation as NodePresentation),
      },
    };
  if (runtimePresentation)
    return {
      ...message,
      data: {
        ...message.data,
        runtimePresentation: await exportNodePresentation(
          config,
          runtimePresentation as NodePresentation,
        ),
      },
    };
  return message;
}

export async function exportNodeSessionEvent(
  config: ExportConfig,
  source: ServerEvent,
): Promise<NodeSessionEvent | undefined> {
  const event = nodeSessionEvent(source);
  if (event?.type !== "reset") return event;
  const { state } = event;
  return {
    ...event,
    senderProjection: true,
    state: {
      ...state,
      messages: await Promise.all(
        state.messages.map((message) => exportNodeMessage(config, message)),
      ),
    },
  };
}

export function nodeSessionEvent(
  event: ServerEvent | NodeSessionEvent,
  fromWire = false,
): NodeSessionEvent | undefined {
  switch (event.type) {
    case "reset": {
      const { state } = event;
      return {
        ...event,
        state: {
          ...state,
          queuedPrompts: nodeQueuedPrompts(state.queuedPrompts),
          messages: state.messages.map((message) => nodeMessage(message, fromWire)),
          activeAssistant: state.activeAssistant && nodeAssistant(state.activeAssistant, "active"),
          activeTools: state.activeTools.map(nodeTool),
        },
      };
    }
    case "state":
      return {
        ...event,
        state: { ...event.state, queuedPrompts: nodeQueuedPrompts(event.state.queuedPrompts) },
      };
    case "assistant":
      return { ...event, assistant: event.assistant && nodeAssistant(event.assistant, "active") };
    case "tools":
      return { ...event, tools: event.tools.map(nodeTool) };
    case "error":
      return event;
    default:
      return undefined;
  }
}
