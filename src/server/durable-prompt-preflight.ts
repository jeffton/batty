import { readFile } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession, ResourceLoader } from "@earendil-works/pi-coding-agent";

type StreamingBehavior = "steer" | "followUp";

type PromptTemplate = {
  name: string;
  content: string;
};

/** AgentSession exposes the extension runner, templates, current prompt, and auth runtime publicly.
 * ResourceLoader is supplied separately because AgentSession intentionally does not expose it. */
export type DurablePromptSdk = Omit<
  Pick<
    AgentSession,
    | "extensionRunner"
    | "promptTemplates"
    | "systemPrompt"
    | "model"
    | "modelRuntime"
    | "isStreaming"
  >,
  "extensionRunner" | "modelRuntime"
> & {
  extensionRunner: Pick<
    AgentSession["extensionRunner"],
    | "getCommand"
    | "createCommandContext"
    | "emitInput"
    | "emitBeforeAgentStart"
    | "createContext"
    | "emitError"
  >;
  modelRuntime: Pick<
    AgentSession["modelRuntime"],
    "hasConfiguredAuth" | "checkAuth" | "isUsingOAuth"
  >;
  resourceLoader?: Pick<ResourceLoader, "getSkills">;
};

export type PrepareDurablePromptOptions = {
  images?: ImageContent[];
  streamingBehavior?: StreamingBehavior;
  signal?: AbortSignal;
  /** Observe in-flight SDK operations so the owner can join them during disposal. */
  onOperation?: (operation: Promise<unknown>) => void;
  resourceLoader?: Pick<ResourceLoader, "getSkills">;
};

export type PreparedDurablePrompt = {
  text: string;
  images?: ImageContent[];
  handled: boolean;
  systemPrompt?: string;
  messages?: Array<Record<string, unknown>>;
};

const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");

async function waitAbortably<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function parseArgs(input: string): string[] {
  const args: string[] = [];
  let value = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const char of input) {
    if (escaped) {
      value += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else value += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (value) args.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  if (escaped) value += "\\";
  if (value) args.push(value);
  return args;
}

function expandTemplate(text: string, templates: ReadonlyArray<PromptTemplate>): string {
  const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return text;
  const template = templates.find(({ name }) => name === match[1]);
  if (!template) return text;
  const args = parseArgs(match[2] ?? "");
  const all = args.join(" ");
  return template.content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_token, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
      if (defaultTarget) {
        const value =
          defaultTarget === "@" || defaultTarget === "ARGUMENTS"
            ? all
            : args[Number(defaultTarget) - 1];
        return value || defaultValue;
      }
      if (sliceStart) {
        const from = Math.max(0, Number(sliceStart) - 1);
        return args.slice(from, sliceLength ? from + Number(sliceLength) : undefined).join(" ");
      }
      if (simple === "ARGUMENTS" || simple === "@") return all;
      return args[Number(simple) - 1] ?? "";
    },
  );
}

/**
 * Run Pi's prompt-time extension/resource transforms without starting an agent turn.
 * This deliberately uses the public ExtensionRunner and ResourceLoader APIs; it never calls
 * prompt(), steer(), followUp(), or the agent loop.
 */
export async function prepareDurablePrompt(
  sdk: DurablePromptSdk,
  text: string,
  options: PrepareDurablePromptOptions = {},
): Promise<PreparedDurablePrompt> {
  const { signal } = options;
  const checkAbort = () => {
    if (signal?.aborted) throw abortError(signal);
  };
  const observe = <T>(operation: Promise<T>): Promise<T> => {
    options.onOperation?.(operation);
    return waitAbortably(operation, signal);
  };
  checkAbort();
  const runner = sdk.extensionRunner;

  // Extension commands precede input hooks and template expansion in Pi's prompt contract.
  if (text.startsWith("/")) {
    const commandName = text.slice(1).split(" ", 1)[0] ?? "";
    const command = runner.getCommand(commandName);
    if (command) {
      const operation = Promise.resolve(
        command.handler(text.slice(commandName.length + 2), runner.createCommandContext()),
      ).catch((error: unknown) => {
        runner.emitError({
          extensionPath: `command:${commandName}`,
          event: "command",
          error: error instanceof Error ? error.message : String(error),
        });
      });
      await observe(operation);
      checkAbort();
      return { text, images: options.images, handled: true };
    }
  }

  const input = await observe(
    runner.emitInput(
      text,
      options.images,
      "interactive",
      sdk.isStreaming ? options.streamingBehavior : undefined,
    ),
  );
  checkAbort();
  if (input.action === "handled") return { text, images: options.images, handled: true };
  let processedText = input.action === "transform" ? input.text : text;
  const images = input.action === "transform" ? (input.images ?? options.images) : options.images;

  if (processedText.startsWith("/skill:")) {
    const splitAt = processedText.indexOf(" ");
    const name = splitAt === -1 ? processedText.slice(7) : processedText.slice(7, splitAt);
    const args = splitAt === -1 ? "" : processedText.slice(splitAt + 1).trim();
    const resources = options.resourceLoader ?? sdk.resourceLoader;
    if (!resources) {
      throw new Error(
        "Skill expansion requires the public ResourceLoader used to create the session",
      );
    }
    const skill = resources.getSkills().skills.find((candidate) => candidate.name === name);
    if (skill) {
      const body = (await observe(readFile(skill.filePath, "utf8")))
        .replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/, "")
        .trim();
      processedText = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>${args ? `\n\n${args}` : ""}`;
    }
  }
  processedText = expandTemplate(processedText, sdk.promptTemplates);
  checkAbort();

  const { model, modelRuntime } = sdk;
  if (!model) throw new Error("Configure an available default model before creating this session");
  const configured =
    sdk.isStreaming ||
    modelRuntime.hasConfiguredAuth(model.provider) ||
    (await observe(modelRuntime.checkAuth(model.provider))) !== undefined;
  checkAbort();
  if (!configured) {
    if (modelRuntime.isUsingOAuth(model.provider)) {
      throw new Error(
        `Authentication failed for "${model.provider}". Credentials may have expired or network is unavailable. Run '/login ${model.provider}' to re-authenticate.`,
      );
    }
    throw new Error(
      `No API key found for "${model.provider}". Configure an API key or run '/login ${model.provider}'.`,
    );
  }

  const before = await observe(
    runner.emitBeforeAgentStart(processedText, images, {
      ...runner.createCommandContext().getSystemPromptOptions(),
      forceSystemPrompt: sdk.systemPrompt,
    }),
  );
  checkAbort();
  return {
    text: processedText,
    images,
    handled: false,
    systemPrompt:
      typeof before.systemPromptOptions.forceSystemPrompt === "string"
        ? before.systemPromptOptions.forceSystemPrompt
        : undefined,
    messages: before.messages,
  };
}
