import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, awaitWithContext } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  estimateTokens,
  type AgentSession,
  type AgentSessionEvent,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  createRegistry,
  defineExtension,
  defineDoc,
  GenerationTask,
  CompactionTask,
  hook,
  section,
  watchEvents,
  type AgentEvent,
  type AgentEventStream,
  type InboxItem,
  type SnapshotEvent,
  type ToolSlot,
  type TaskId,
  type Submission,
} from "@earendil-works/pi-durable";
import type { PromptDisposition, QueuedPrompt } from "@/shared/types";
import { AgentSessionController, type AgentSessionPromptOptions } from "./agent-session-controller";
import { openDurableSession } from "./durable-session-store";
import { createDurableToolExtension } from "./durable-tools";
import type { SessionStore } from "./session-store";
import { prepareDurablePrompt } from "./durable-prompt-preflight";

type CustomInput = Parameters<AgentSessionController["sendCustomMessage"]>[0];
const context = BACKGROUND_CONTEXT;
const PromptDoc = defineDoc<{ override: string | null }>({
  kind: "batty.prompt",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ override: null }),
});

/** Durable owns generation, admission, queues and tool scheduling. The SDK supplies resources and host tools only. */
export class DurableAgentSessionController extends AgentSessionController {
  private readonly durableListeners = new Set<(event: AgentSessionEvent) => void | Promise<void>>();
  private readonly deliveryContext = new AsyncLocalStorage<boolean>();
  private readonly deliveries = new Set<Promise<void>>();
  private readonly deliveryErrors: unknown[] = [];
  private readonly registry = createRegistry();
  private backing!: Awaited<ReturnType<typeof openDurableSession>>;
  private stream!: AgentEventStream;
  private busy = false;
  private partial?: AssistantMessage;
  private readonly durableTools = new Map<string, ToolSlot>();
  private inbox: Array<{ id: InboxItem["id"]; mode: InboxItem["mode"] }> = [];
  private queued: QueuedPrompt[] = [];
  private compactions = new Set<TaskId>();
  private retrying = false;
  private handoffRequested = false;
  private durableClosing?: Promise<void>;
  private started = false;
  private durableReloadRequested = false;
  private settlementPending = false;
  private readonly refreshSdkContext: () => void;
  private readonly setSdkModel: AgentSession["setModel"];
  private readonly setSdkThinkingLevel: AgentSession["setThinkingLevel"];
  private observedTail = 0;
  private readonly observerWaiters = new Set<() => void>();
  private preparationAdmission = Promise.resolve();
  private readonly durablePreflights = new Set<AbortController>();
  private readonly preflightOperations = new Set<Promise<unknown>>();

  private constructor(sdk: AgentSession, store: SessionStore) {
    super(sdk, store);
    this.refreshSdkContext = sdk.refreshContext.bind(sdk);
    this.setSdkModel = sdk.setModel.bind(sdk);
    this.setSdkThinkingLevel = sdk.setThinkingLevel.bind(sdk);
  }

  static async open(
    sdk: AgentSession,
    store: SessionStore,
    models: ModelRuntime,
    overrides: { model?: Model<Api>; thinkingLevel?: ThinkingLevel } = {},
  ) {
    const controller = new DurableAgentSessionController(sdk, store);
    controller.refreshRegistry();
    const settings = sdk.settingsManager;
    try {
      controller.backing = await openDurableSession(store, {
        models,
        registry: controller.registry,
        settings: {
          get compaction() {
            return settings.getCompactionSettings(sdk.model);
          },
          get retry() {
            return settings.getRetrySettings();
          },
          get steeringMode() {
            return settings.getSteeringMode();
          },
          get followUpMode() {
            return settings.getFollowUpMode();
          },
          toolExecution: sdk.agent.toolExecution,
        },
        onReport: (error) => controller.deliveryErrors.push(error),
      });
      const agent = await controller.backing.conversation.agent(context);
      if (!agent.model || overrides.model || overrides.thinkingLevel !== undefined) {
        const selected = overrides.model ?? sdk.model!;
        await controller.backing.conversation.configure(
          {
            model:
              overrides.model || !agent.model
                ? { provider: selected.provider, modelId: selected.id }
                : agent.model,
            thinkingLevel:
              overrides.thinkingLevel ?? (!agent.model ? sdk.thinkingLevel : agent.thinkingLevel),
            cwd: store.native.getCwd(),
          },
          context,
        );
      }
      {
        const configured = await controller.backing.conversation.agent(context);
        const model = models.getModel(configured.model!.provider, configured.model!.modelId);
        if (!model)
          throw new Error(
            `Durable session model is unavailable: ${configured.model!.provider}/${configured.model!.modelId}`,
          );
        sdk.agent.state.model = model;
        sdk.agent.state.thinkingLevel = configured.thinkingLevel;
      }
      return controller;
    } catch (error) {
      await controller.backing?.close();
      sdk.dispose();
      store.release();
      throw error;
    }
  }

  /** Bind resources and MCP before allowing recovered tasks to execute. */
  async start(): Promise<void> {
    this.refreshRegistry();
    await this.backing.syncHostEntries();
    this.stream = await watchEvents(this.backing.harness, this.backing.conversation.id, context);
    await this.applySnapshot(this.stream.snapshot);
    this.stream.start(async (events) => {
      for (const event of events) await this.acceptEvent(event);
      if (this.settlementPending && !this.busy) {
        this.settlementPending = false;
        if (this.durableReloadRequested && !this.durableClosing) {
          this.durableReloadRequested = false;
          await this.sdk.reload();
          this.refreshRegistry();
        }
        this.emit({ type: "agent_settled" } as AgentSessionEvent);
      }
      for (const wake of this.observerWaiters) wake();
    });
    void this.stream.closed.then((end) => {
      if (end.reason === "listener_error") {
        this.deliveryErrors.push(end.error);
        for (const wake of this.observerWaiters) wake();
      }
    });
    this.started = true;
    // SDK extension callbacks must use durable admission, never start the SDK agent loop.
    this.sdk.prompt = async (text, options) => {
      await this.prompt(text, options);
    };
    this.sdk.sendCustomMessage = async (message, options) => {
      await this.sendCustomMessage(message as CustomInput, { ...options, steerWhenBusy: true });
    };
    this.sdk.setModel = (model) => this.setModel(model);
    this.sdk.setThinkingLevel = (level) => {
      this.setSdkThinkingLevel(level);
      void this.backing.conversation
        .configure({ thinkingLevel: level }, context)
        .catch((error) => this.deliveryErrors.push(error));
    };
    this.sdk.compact = async (instructions) => {
      await this.compact(instructions);
      const entry = this.sessionManager.getBranch().findLast((item) => item.type === "compaction");
      if (!entry || entry.type !== "compaction") throw new Error("Compaction produced no summary");
      return {
        summary: entry.summary,
        firstKeptEntryId: entry.firstKeptEntryId,
        tokensBefore: entry.tokensBefore,
        details: entry.details,
        usage: entry.usage,
      };
    };
    this.sdk.abortCompaction = () => this.abortCompaction();
    this.sdk.abort = () => this.abort();
    this.sdk.waitForIdle = () => this.waitForIdle();
    Object.defineProperty(this.sdk, "isStreaming", { get: () => this.busy });
    Object.defineProperty(this.sdk, "isIdle", { get: () => !this.busy && !this.isCompacting });
    Object.defineProperty(this.sdk, "pendingMessageCount", { get: () => this.pendingMessageCount });
    const activate = this.sdk.setActiveToolsByName.bind(this.sdk);
    this.sdk.setActiveToolsByName = (names) => {
      activate(names);
      this.refreshRegistry();
    };
    this.backing.harness.resume();
  }

  private refreshRegistry(): void {
    this.registry.install(
      createDurableToolExtension(this.sdk, {
        shouldEndTurn: () => this.handoffRequested && this.pendingMessageCount === 0,
        beforeExecute: async () => {
          this.sdk.agent.state.messages = [
            ...(await this.backing.conversation.context(context)).messages,
          ];
        },
        recordArtifacts: async (toolCallId, details, toolTaskId) => {
          await this.backing.conversation.commit(
            (tx) =>
              tx.appendEntry(this.backing.conversation.id, {
                kind: "batty.tool-artifacts",
                data: JSON.parse(JSON.stringify({ toolCallId, toolTaskId, details })) as JsonValue,
              }),
            context,
          );
        },
      }),
    );
    this.registry.install(
      defineExtension({
        name: "batty-resources",
        sections: [
          section(
            "batty",
            async (input, invocation) => {
              const prompt = await input.read.snapshot(PromptDoc, input.conversationId, invocation);
              return prompt?.override ?? this.sdk.systemPrompt;
            },
            { tag: false },
          ),
        ],
        hooks: [
          hook(GenerationTask, {
            beforeRequest: async (request, _api, invocation) => {
              // Nested codemode calls consult the SDK's executable tool context, not its loop.
              this.sdk.agent.state.messages = [...request.messages];
              const messages = await this.sdk.agent.transformContext?.(
                [...request.messages],
                invocation.abortSignal,
              );
              if (messages) return { messages: convertToLlm(messages) };
            },
            afterTools: async (_assistant, results, _api, invocation) => {
              await awaitWithContext(this.waitForObservation(Math.max(0, ...results)), invocation);
              await awaitWithContext(this.flushDelivery(), invocation);
            },
          }),
          hook(CompactionTask, {
            beforeCompact: async (compaction, _api, invocation) => {
              await this.backing.projectEntries(compaction.entries);
              const branch = this.sessionManager.getBranch();
              const firstKept = branch.find(
                (entry) =>
                  entry.type === "message" &&
                  (entry.message as AgentMessage & { battyDurableEntryId?: string })
                    .battyDurableEntryId === String(compaction.firstKept),
              );
              const response = await this.sdk.extensionRunner.emit({
                type: "session_before_compact",
                branchEntries: branch,
                preparation: {
                  firstKeptEntryId: firstKept?.id ?? this.sessionManager.getLeafId()!,
                  messagesToSummarize: [...compaction.messages],
                  turnPrefixMessages: [],
                  isSplitTurn: false,
                  tokensBefore: compaction.messages.reduce(
                    (total, message) => total + estimateTokens(message),
                    0,
                  ),
                  fileOps: { read: new Set(), written: new Set(), edited: new Set() },
                  settings: this.sdk.settingsManager.getCompactionSettings(this.model),
                },
                customInstructions: compaction.instructions,
                reason: compaction.reason,
                willRetry: compaction.reason === "overflow",
                signal: invocation.abortSignal!,
              });
              if (response?.cancel) return { decline: true as const };
              if (response?.compaction) return { summary: response.compaction.summary };
            },
          }),
        ],
      }),
    );
  }

  override get messages() {
    const projected = new Map(
      this.sessionManager
        .getEntries()
        .flatMap((entry) =>
          entry.type === "message"
            ? [
                [
                  (entry.message as AgentMessage & { battyDurableEntryId?: string })
                    .battyDurableEntryId,
                  entry.message,
                ] as const,
              ]
            : [],
        ),
    );
    return this.sdk.messages.map((message) => {
      const id = (message as AgentMessage & { battyDurableEntryId?: string }).battyDurableEntryId;
      return id ? (projected.get(id) ?? message) : message;
    });
  }

  override get isStreaming() {
    return this.busy;
  }
  override get isCompacting() {
    return this.compactions.size > 0;
  }
  override get pendingMessageCount() {
    return this.inbox.filter((item) => item.mode !== "write").length;
  }
  override get streamingMessage() {
    return this.partial;
  }
  override get runningTools() {
    return [...this.durableTools.values()]
      .filter((tool) => tool.status !== "done")
      .map((tool) => ({
        toolCallId: tool.callId,
        toolName: tool.name,
        args: {},
        partialResult: {
          content: [{ type: "text", text: tool.output ?? "" }],
          details: tool.details,
        },
      }));
  }

  override subscribe(listener: (event: AgentSessionEvent) => void | Promise<void>): () => void {
    this.durableListeners.add(listener);
    return () => this.durableListeners.delete(listener);
  }

  private emit(event: AgentSessionEvent): void {
    const delivery = Promise.resolve().then(() =>
      this.deliveryContext.run(true, async () => {
        await Promise.all([...this.durableListeners].map((listener) => listener(event)));
      }),
    );
    this.deliveries.add(delivery);
    void delivery.then(
      () => this.deliveries.delete(delivery),
      (error) => {
        this.deliveries.delete(delivery);
        this.deliveryErrors.push(error);
      },
    );
  }

  private async flushDelivery(): Promise<void> {
    if (this.deliveryContext.getStore()) return;
    while (this.deliveries.size) await Promise.allSettled(this.deliveries);
    if (this.deliveryErrors.length) throw this.deliveryErrors.shift();
  }

  private async applySnapshot(snapshot: SnapshotEvent): Promise<void> {
    await this.backing.projectEntries(snapshot.entries);
    this.refreshSdkContext();
    this.busy = !!snapshot.run;
    this.partial = snapshot.generation?.message;
    this.retrying = !!snapshot.generation?.retry;
    this.durableTools.clear();
    for (const tool of snapshot.tools) this.durableTools.set(tool.callId, { ...tool });
    this.compactions = new Set(snapshot.compactions.map((item) => item.taskId));
    this.inbox = [...snapshot.inbox];
    this.observedTail = Math.max(this.observedTail, ...snapshot.entries.map((entry) => entry.id));
    await this.refreshQueue();
  }

  private async refreshQueue(): Promise<void> {
    const view = await this.backing.conversation.viewState(context);
    try {
      const items = (view.value.docs["pi.inbox"] as unknown as { items: InboxItem[] }).items;
      this.inbox = items.map((item) => ({ id: item.id, mode: item.mode }));
      const queued: QueuedPrompt[] = [];
      for (const item of items) {
        if (item.mode === "write") continue;
        const submission = await this.backing.harness.submission(item.id, context);
        const record = await submission!.status(context);
        queued.push({
          kind: item.mode,
          index: queued.filter((prompt) => prompt.kind === item.mode).length,
          text:
            typeof item.content === "string"
              ? item.content
              : item.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n"),
          clientMessageId: record.requestId?.startsWith("client:")
            ? record.requestId.slice(7)
            : undefined,
        });
      }
      this.queued = queued;
    } finally {
      view.dispose();
    }
  }

  private async acceptEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "snapshot":
        await this.applySnapshot(event);
        this.emit({ type: "queue_update" } as AgentSessionEvent);
        if (this.busy) this.emit({ type: "agent_start" });
        else this.settlementPending = true;
        break;
      case "entry_appended":
        await this.backing.projectEntries([event.entry]);
        this.refreshSdkContext();
        this.observedTail = Math.max(this.observedTail, event.entry.id);
        this.emit({ type: "entry_appended", entry: event.entry } as unknown as AgentSessionEvent);
        break;
      case "message_end":
        await this.backing.projectEntries([event.entry]);
        this.refreshSdkContext();
        this.observedTail = Math.max(this.observedTail, event.entry.id);
        for (const message of event.entry.model ?? []) {
          if (message.role === "assistant") this.partial = undefined;
          this.emit({ type: "message_end", message });
        }
        break;
      case "message_start":
        if (event.message.role === "system") break;
        if (event.message.role === "assistant") this.partial = structuredClone(event.message);
        this.emit(event);
        break;
      case "message_update":
        for (const change of event.changes) {
          if (change.type === "message") this.partial = structuredClone(change.message);
          else if (this.partial) {
            if ("block" in change)
              this.partial.content[change.contentIndex] = structuredClone(change.block);
            else if (change.type === "text_delta" || change.type === "thinking_delta") {
              const block = this.partial.content[change.contentIndex]!;
              if (change.type === "text_delta" && block.type === "text") block.text += change.delta;
              if (change.type === "thinking_delta" && block.type === "thinking")
                block.thinking += change.delta;
            } else if (change.type === "toolcall_delta") {
              let target = this.partial.content[change.contentIndex] as unknown as Record<
                string | number,
                unknown
              >;
              for (const key of change.path.slice(0, -1)) target = target[key] as typeof target;
              const key = change.path.at(-1)!;
              target[key] = String(target[key]) + change.delta;
            }
          }
        }
        if (this.partial) {
          this.partial.usage = event.usage;
          this.emit({
            type: "message_update",
            message: structuredClone(this.partial),
            assistantMessageEvent: { type: "start", partial: structuredClone(this.partial) },
          });
        }
        break;
      case "run_start":
        this.settlementPending = false;
        this.busy = true;
        this.handoffRequested = false;
        await this.sdk.extensionRunner.emit({ type: "agent_start" });
        this.emit({ type: "agent_start" });
        break;
      case "run_end":
        this.busy = false;
        this.partial = undefined;
        this.handoffRequested = false;
        this.retrying = false;
        await this.sdk.extensionRunner.emit({ type: "agent_end", messages: this.sdk.messages });
        this.emit({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent);
        this.settlementPending = true;
        break;
      case "tool_execution_start":
        this.durableTools.set(event.toolCallId, {
          callId: event.toolCallId,
          name: event.toolName,
          status: "running",
        });
        this.emit(event);
        break;
      case "tool_execution_update": {
        const tool = this.durableTools.get(event.toolCallId)!;
        if (event.output)
          tool.output =
            "set" in event.output
              ? event.output.set
              : (tool.output ?? "").slice(event.output.trimStart ?? 0) +
                (event.output.append ?? "");
        if (event.details !== undefined) tool.details = event.details;
        this.emit({
          type: "tool_execution_update",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: {},
          partialResult: {
            content: [{ type: "text", text: tool.output ?? "" }],
            details: tool.details,
          },
        });
        break;
      }
      case "tool_execution_end": {
        this.durableTools.delete(event.toolCallId);
        const result = event.entry?.model?.find((message) => message.role === "toolResult");
        this.emit({
          type: "tool_execution_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: { content: result?.content ?? [], details: result?.details },
          isError: result?.isError ?? true,
        });
        break;
      }
      case "inbox_update":
        this.inbox = [...event.items];
        await this.refreshQueue();
        this.emit({ type: "queue_update" } as AgentSessionEvent);
        break;
      case "compaction_start":
        this.compactions.add(event.taskId);
        this.emit({ type: "compaction_start", reason: event.reason } as AgentSessionEvent);
        break;
      case "compaction_end":
        this.compactions.delete(event.taskId);
        this.emit({
          type: "compaction_end",
          reason: event.reason,
          aborted: false,
          willRetry: event.reason === "overflow",
        } as AgentSessionEvent);
        break;
      case "auto_retry_start":
        this.retrying = true;
        this.emit(event as unknown as AgentSessionEvent);
        break;
      case "auto_retry_end":
        this.retrying = false;
        this.emit({ ...event, success: true } as AgentSessionEvent);
        break;
      case "task_failed":
        this.deliveryErrors.push(new Error(`${event.kind}: ${event.message}`));
        break;
    }
  }

  private async prepare(): Promise<void> {
    if (this.durableClosing) throw new Error("Session is closed");
    await this.backing.syncHostEntries();
    this.refreshSdkContext();
    this.refreshRegistry();
  }

  override async prompt(
    text: string,
    options: AgentSessionPromptOptions = {},
  ): Promise<PromptDisposition> {
    const preflight = new AbortController();
    this.durablePreflights.add(preflight);
    const previous = this.preparationAdmission;
    let release!: () => void;
    this.preparationAdmission = new Promise<void>((resolve) => {
      release = resolve;
    });
    let submission: Submission;
    try {
      await previous;
      if (this.durableClosing) throw new Error("Session is closed");
      preflight.signal.throwIfAborted();
      await this.prepare();
      const prepared = await prepareDurablePrompt(this.sdk, text, {
        ...options,
        signal: preflight.signal,
        resourceLoader: this.sdk.resourceLoader,
        onOperation: (operation) => {
          this.preflightOperations.add(operation);
          void operation.then(
            () => this.preflightOperations.delete(operation),
            () => this.preflightOperations.delete(operation),
          );
        },
      });
      if (prepared.handled) return { disposition: "completed" };
      preflight.signal.throwIfAborted();
      if (!this.busy) {
        await this.backing.conversation.commit(async (tx) => {
          (await tx.doc(PromptDoc, this.backing.conversation.id)).override =
            prepared.systemPrompt ?? null;
        }, context);
      }
      for (const message of prepared.messages ?? []) {
        await this.sessionManager.appendMessage(
          message as Parameters<SessionStore["appendMessage"]>[0],
        );
      }
      await this.backing.syncHostEntries();
      preflight.signal.throwIfAborted();
      const content = prepared.images?.length
        ? [{ type: "text" as const, text: prepared.text }, ...prepared.images]
        : prepared.text;
      submission = await this.backing.conversation.submit(
        {
          type: "input",
          content,
          requestId: options.clientMessageId ? `client:${options.clientMessageId}` : randomUUID(),
          whenBusy: options.streamingBehavior ?? "reject",
        },
        context,
      );
    } finally {
      this.durablePreflights.delete(preflight);
      release();
    }
    const status = await submission.status(context);
    if (status.status === "placed") this.busy = true;
    if (status.status === "queued") {
      await this.refreshQueue();
      return { disposition: "queued", entryId: String(submission.id) };
    }
    await submission.wait(context);
    await this.waitForIdle();
    return { disposition: "completed" };
  }

  override getQueuedPrompts(): QueuedPrompt[] {
    return this.queued;
  }
  override async removeQueuedPrompt(kind: "steer" | "followUp", index: number): Promise<void> {
    const item = this.inbox.filter((entry) => entry.mode === kind)[index];
    if (!item) throw new Error("Queued prompt not found");
    await this.backing.harness.abortSubmission(item.id, context, this.backing.conversation.id);
    await this.refreshQueue();
  }
  override async setModel(model: Model<Api>): Promise<void> {
    await this.backing.conversation.configure(
      { model: { provider: model.provider, modelId: model.id } },
      context,
    );
    await this.setSdkModel(model);
  }
  override async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.backing.conversation.configure({ thinkingLevel: level }, context);
    this.setSdkThinkingLevel(level);
  }
  override async setActiveToolsByName(names: string[]): Promise<void> {
    await super.setActiveToolsByName(names);
    this.refreshRegistry();
  }
  override async reloadResources(): Promise<void> {
    if (this.busy) {
      this.durableReloadRequested = true;
      return;
    }
    await this.sdk.reload();
    this.refreshRegistry();
  }
  override requestTurnEnd(): void {
    this.handoffRequested = true;
  }
  private async waitForObservation(tail: number, idle = false): Promise<void> {
    await new Promise<void>((resolve) => {
      const wake = () => {
        if (!this.deliveryErrors.length && (this.observedTail < tail || (idle && this.busy)))
          return;
        this.observerWaiters.delete(wake);
        resolve();
      };
      this.observerWaiters.add(wake);
      wake();
    });
  }

  override async waitForIdle(): Promise<void> {
    if (this.durableClosing && !this.busy) {
      await this.flushDelivery();
      return;
    }
    await this.backing.conversation.waitForIdle(context);
    if (this.durableClosing && !this.busy) {
      await this.flushDelivery();
      return;
    }
    // The observer projects every finalized entry before publishing the idle boundary.
    await this.waitForObservation(0, true);
    await this.flushDelivery();
  }
  override async abort(): Promise<void> {
    for (const preflight of this.durablePreflights) preflight.abort();
    await this.backing.conversation.abort(context);
    await this.waitForIdle();
  }
  override abortCompaction(): void {
    for (const id of this.compactions) void this.backing.harness.abortTask(id as never, context);
  }
  override async compact(instructions?: string): Promise<void> {
    const id = await this.backing.conversation.compact(instructions, context);
    const result = await this.backing.harness.waitForTask(id, context);
    if (result.state.outcome.status === "completed") {
      const summary = result.state.outcome.result;
      let entryId = summary.entryId;
      if (summary.submissionId !== undefined) {
        const submission = await this.backing.harness.submission(summary.submissionId, context);
        const placed = await submission!.wait(context);
        if (placed.status === "done") entryId = placed.entry;
      }
      if (entryId !== undefined) await this.waitForObservation(entryId);
    }
    await this.waitForIdle();
    if (result.state.outcome.status === "failed")
      throw new Error(result.state.outcome.error.message);
    if (result.state.outcome.status === "aborted") throw new Error("Compaction cancelled");
  }
  private async admitCustomInput(
    message: CustomInput,
    whenBusy: "steer" | "reject",
    identity: string,
    attempt = 0,
  ): Promise<Submission> {
    const submission = await this.backing.conversation.submit(
      {
        type: "input",
        requestId: `custom-input:${identity}:${attempt}`,
        content: message.content,
        whenBusy,
      },
      context,
    );
    if ((await submission.status(context)).status === "placed") this.busy = true;
    return submission;
  }

  private customIdentity(message: CustomInput): string {
    const deliveryId = message.details?.battyResultReplyId ?? randomUUID();
    return Buffer.from(
      JSON.stringify({
        deliveryId,
        customType: message.customType,
        display: message.display,
        details: { ...message.details, battyDeliveryId: deliveryId },
      }),
    ).toString("base64url");
  }

  override async queueCustomSteeringMessage(message: CustomInput): Promise<void> {
    await this.prepare();
    await this.admitCustomInput(message, "steer", this.customIdentity(message));
    await this.refreshQueue();
  }

  override async sendCustomMessage(
    message: CustomInput,
    options: Parameters<AgentSessionController["sendCustomMessage"]>[1] = {},
  ): Promise<void> {
    await this.prepare();
    if (!options.triggerTurn) {
      const submission = await this.backing.conversation.submit(
        {
          type: "write",
          requestId: `custom:${message.details?.battyResultReplyId ?? randomUUID()}`,
          entry: {
            kind: "batty.custom-message",
            data: JSON.parse(JSON.stringify({ ...message, timestamp: Date.now() })) as JsonValue,
            model: [{ role: "user", content: message.content, timestamp: Date.now() }],
          },
        },
        context,
      );
      options.onAccepted?.();
      await submission.wait(context);
    } else {
      const identity = this.customIdentity(message);
      let attempt = 0;
      let submission = await this.admitCustomInput(
        message,
        options.steerWhenBusy ? "steer" : "reject",
        identity,
        attempt,
      );
      options.onAccepted?.();
      for (;;) {
        const settled = await submission.wait(context);
        if (
          settled.status !== "unanswered" ||
          settled.reason !== "aborted" ||
          !options.steerWhenBusy
        )
          break;
        await this.backing.conversation.waitForIdle(context);
        submission = await this.admitCustomInput(message, "steer", identity, ++attempt);
      }
      await this.waitForIdle();
    }
    await this.flushDelivery();
  }

  override dispose(): Promise<void> {
    return (this.durableClosing ??= (async () => {
      // Closing checkpoints work; explicit abort is the only operation that withdraws inputs.
      for (const preflight of this.durablePreflights) preflight.abort();
      await this.preparationAdmission;
      await Promise.allSettled(this.preflightOperations);
      await this.backing.close();
      if (this.started) await this.stream.stop();
      await this.flushDelivery();
      await this.sdk.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      this.sdk.dispose();
      this.sessionManager.release();
    })());
  }
}
