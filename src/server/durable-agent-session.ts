import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, awaitWithContext } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import {
  convertToLlm,
  estimateTokens,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  AgentDoc,
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
import type {
  AgentSessionController,
  AgentSessionPromptOptions,
  CustomSessionInput,
} from "./agent-session-controller";
import { createDurableToolExtension } from "./durable-tools";
import type { SessionResources } from "./session-resources";
import type { SessionStore } from "./session-store";
import { SESSION_TOOLS_CUSTOM_TYPE } from "./session-metadata";
import { prepareDurablePrompt } from "./durable-prompt-preflight";
import { getSessionContextUsage } from "./pi-context-usage";

const context = BACKGROUND_CONTEXT;
const PromptDoc = defineDoc<{ override: string | null }>({
  kind: "batty.prompt",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ override: null }),
});

/** Durable owns the conversation, admission, execution and recovery; resources own host tools. */
export class DurableAgentSessionController implements AgentSessionController {
  private readonly listeners = new Set<(event: AgentSessionEvent) => void | Promise<void>>();
  private readonly deliveryContext = new AsyncLocalStorage<boolean>();
  private readonly deliveries = new Set<Promise<void>>();
  private readonly errors: unknown[] = [];
  private stream!: AgentEventStream;
  private busy = false;
  private partial?: AssistantMessage;
  private readonly tools = new Map<string, ToolSlot>();
  private inbox: Array<{ id: InboxItem["id"]; mode: InboxItem["mode"] }> = [];
  private queued: QueuedPrompt[] = [];
  private compactions = new Set<TaskId>();
  private handoffRequested = false;
  private closing?: Promise<void>;
  private started = false;
  private reloadRequested = false;
  private settlementPending = false;
  private completionHolds = 0;
  private observedTail = 0;
  private readonly observerWaiters = new Set<() => void>();
  private admission = Promise.resolve();
  private readonly preflights = new Set<AbortController>();
  private readonly preflightOperations = new Set<Promise<unknown>>();
  private readonly resourceOperations = new Set<Promise<unknown>>();
  private selectedModel: Model<Api>;
  private selectedThinking: ThinkingLevel;
  regularToolNames = new Set<string>();

  private constructor(
    readonly resources: SessionResources,
    readonly sessionManager: SessionStore,
    model: Model<Api>,
    thinkingLevel: ThinkingLevel,
  ) {
    this.selectedModel = model;
    this.selectedThinking = clampThinkingLevel(model, thinkingLevel);
  }

  static async open(
    resources: SessionResources,
    store: SessionStore,
    model: Model<Api>,
    thinkingLevel: ThinkingLevel,
  ) {
    const controller = new DurableAgentSessionController(resources, store, model, thinkingLevel);
    const settings = resources.settingsManager;
    store.configureRuntime({
      models: resources.modelRuntime,
      settings: {
        get compaction() {
          return settings.getCompactionSettings(controller.model);
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
        toolExecution: resources.toolExecution,
      },
    });
    await store.configure({
      model: { provider: model.provider, modelId: model.id },
      thinkingLevel: controller.thinkingLevel,
    });
    controller.refreshRegistry();
    return controller;
  }

  /** Bind resources before resuming recovered work. */
  async start(): Promise<void> {
    this.resources.bind({
      actions: {
        sendMessage: (message, options) =>
          this.trackOperation(
            this.sendCustomMessage(message as CustomSessionInput, {
              ...options,
              steerWhenBusy: true,
            }),
          ),
        sendUserMessage: (content, options) => {
          const text =
            typeof content === "string"
              ? content
              : content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n");
          const images =
            typeof content === "string"
              ? undefined
              : content.filter((part) => part.type === "image");
          this.trackOperation(this.prompt(text, { images, streamingBehavior: options?.deliverAs }));
        },
        appendEntry: (customType, data) =>
          this.trackOperation(this.sessionManager.appendCustomEntry(customType, data)),
        setSessionName: (name) => this.trackOperation(this.sessionManager.setSessionName(name)),
        getSessionName: () => this.sessionName,
        setLabel: (entryId, label) =>
          this.trackOperation(this.sessionManager.setLabel(entryId, label)),
        setModel: async (model) => {
          await this.setModel(model);
          return true;
        },
        getThinkingLevel: () => this.thinkingLevel,
        setThinkingLevel: (level) => this.trackOperation(this.setThinkingLevel(level)),
      },
      context: {
        getModel: () => this.model,
        getScopedModels: () => [],
        isIdle: () => !this.isStreaming && !this.isCompacting,
        getSignal: () => undefined,
        hasPendingMessages: () => this.pendingMessageCount > 0,
        getContextUsage: () => getSessionContextUsage(this),
        compact: (options) =>
          this.trackOperation(
            this.compact(options?.customInstructions).then(
              () => {
                const entry = this.sessionManager
                  .getBranch()
                  .findLast((entry) => entry.type === "compaction");
                if (entry?.type === "compaction") options?.onComplete?.(entry);
              },
              (error: Error) => {
                if (options?.onError) options.onError(error);
                else throw error;
              },
            ),
          ),
        abort: () => this.trackOperation(this.abort()),
        shutdown: () => {
          void this.dispose();
        },
      },
      getMessages: () => this.messages,
      emit: (event) => this.emit(event),
      toolsChanged: () => this.configureTools(),
    });
    await this.resources.start();
    await this.configureTools();
    this.stream = await watchEvents(
      this.sessionManager.harness,
      this.sessionManager.conversation.id,
      context,
    );
    await this.applySnapshot(this.stream.snapshot);
    this.stream.start(async (events) => {
      for (const event of events) await this.acceptEvent(event);
      await this.publishSettlement();
      for (const wake of this.observerWaiters) wake();
    });
    void this.stream.closed.then((end) => {
      if (end.reason === "listener_error") {
        this.errors.push(end.error);
        for (const wake of this.observerWaiters) wake();
      }
    });
    this.started = true;
    this.sessionManager.harness.resume();
  }

  private async configureTools(): Promise<void> {
    this.refreshRegistry();
    await this.sessionManager.conversation.commit(async (tx) => {
      (await tx.doc(AgentDoc, this.sessionManager.conversation.id)).tools =
        this.resources.declaredTools.map((tool) => tool.name);
    }, context);
  }
  private refreshRegistry(): void {
    this.sessionManager.registry.install(
      createDurableToolExtension(this.resources, {
        shouldEndTurn: () => this.handoffRequested && this.pendingMessageCount === 0,
        beforeExecute: () => this.sessionManager.refresh(),
        recordArtifacts: async (toolCallId, details, toolTaskId) => {
          await this.sessionManager.conversation.commit(
            (tx) =>
              tx.appendEntry(this.sessionManager.conversation.id, {
                kind: "batty.tool-artifacts",
                data: JSON.parse(JSON.stringify({ toolCallId, toolTaskId, details })) as JsonValue,
              }),
            context,
          );
        },
      }),
    );
    this.sessionManager.registry.install(
      defineExtension({
        name: "batty-resources",
        sections: [
          section(
            "batty",
            async (input, invocation) => {
              const prompt = await input.read.snapshot(PromptDoc, input.conversationId, invocation);
              return prompt?.override ?? this.resources.systemPrompt;
            },
            { tag: false },
          ),
        ],
        hooks: [
          hook(GenerationTask, {
            beforeRequest: async (request) => {
              const messages = await this.resources.extensionRunner.emitContext([
                ...request.messages,
              ]);
              return { messages: convertToLlm(messages) };
            },
            afterTools: async (_assistant, results, _api, invocation) => {
              await awaitWithContext(this.waitForObservation(Math.max(0, ...results)), invocation);
              await awaitWithContext(this.flushResourceOperations(), invocation);
              await awaitWithContext(this.flushDelivery(), invocation);
            },
          }),
          hook(CompactionTask, {
            beforeCompact: async (compaction, _api, invocation) => {
              await this.sessionManager.observeEntries(compaction.entries);
              const branch = this.sessionManager.getBranch();
              const response = await this.resources.extensionRunner.emit({
                type: "session_before_compact",
                branchEntries: branch,
                preparation: {
                  firstKeptEntryId: String(compaction.firstKept),
                  messagesToSummarize: [...compaction.messages],
                  turnPrefixMessages: [],
                  isSplitTurn: false,
                  tokensBefore: compaction.messages.reduce(
                    (total, message) => total + estimateTokens(message),
                    0,
                  ),
                  fileOps: { read: new Set(), written: new Set(), edited: new Set() },
                  settings: this.settingsManager.getCompactionSettings(this.model),
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

  get sessionId() {
    return this.sessionManager.getSessionId();
  }
  get sessionFile() {
    return this.sessionManager.getSessionFile()!;
  }
  get sessionName() {
    return this.sessionManager.getSessionName();
  }
  get model() {
    return this.selectedModel;
  }
  get thinkingLevel() {
    return this.selectedThinking;
  }
  get messages(): AgentMessage[] {
    return this.sessionManager.buildSessionProjection().messages;
  }
  get settingsManager() {
    return this.resources.settingsManager;
  }
  get resourceLoader() {
    return this.resources.resourceLoader;
  }
  get isStreaming() {
    return this.busy;
  }
  get isCompacting() {
    return this.compactions.size > 0;
  }
  get pendingMessageCount() {
    return this.inbox.filter((item) => item.mode !== "write").length;
  }
  get streamingMessage() {
    return this.partial;
  }
  get runningTools() {
    return [...this.tools.values()]
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
  getAvailableThinkingLevels() {
    return getSupportedThinkingLevels(this.model);
  }
  getActiveToolNames() {
    return this.resources.activeToolNames;
  }
  async persistActiveTools() {
    await this.sessionManager.appendCustomEntry(SESSION_TOOLS_CUSTOM_TYPE, {
      activeToolNames: this.getActiveToolNames().filter((name) => this.regularToolNames.has(name)),
    });
  }
  async setActiveToolsByName(names: string[]) {
    await this.resources.setActiveToolsByName(names);
    await this.persistActiveTools();
  }
  async setModel(model: Model<Api>): Promise<void> {
    const level = clampThinkingLevel(model, this.thinkingLevel);
    await this.sessionManager.configure({
      model: { provider: model.provider, modelId: model.id },
      thinkingLevel: level,
    });
    this.selectedModel = model;
    this.selectedThinking = level;
  }
  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    const selected = clampThinkingLevel(this.model, level);
    await this.sessionManager.configure({ thinkingLevel: selected });
    this.selectedThinking = selected;
    this.emit({ type: "thinking_level_changed", level: selected });
  }
  subscribe(listener: (event: AgentSessionEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(event: AgentSessionEvent): void {
    const delivery = Promise.resolve().then(() =>
      this.deliveryContext.run(true, async () => {
        await Promise.all([...this.listeners].map((listener) => listener(event)));
      }),
    );
    this.deliveries.add(delivery);
    void delivery.then(
      () => this.deliveries.delete(delivery),
      (error) => {
        this.deliveries.delete(delivery);
        this.errors.push(error);
      },
    );
  }
  private trackOperation(operation: Promise<unknown>): void {
    this.resourceOperations.add(operation);
    void operation.then(
      () => this.resourceOperations.delete(operation),
      (error) => {
        this.resourceOperations.delete(operation);
        this.errors.push(error);
      },
    );
  }
  private async flushResourceOperations(): Promise<void> {
    await this.resources.flushOperations();
    while (this.resourceOperations.size) await Promise.allSettled(this.resourceOperations);
  }
  private async flushDelivery(): Promise<void> {
    if (this.deliveryContext.getStore()) return;
    while (this.deliveries.size) await Promise.allSettled(this.deliveries);
    if (this.errors.length) throw this.errors.shift();
  }
  private async applySnapshot(snapshot: SnapshotEvent): Promise<void> {
    await this.sessionManager.observeEntries(snapshot.entries);
    this.busy = !!snapshot.run;
    this.partial = snapshot.generation?.message;
    this.tools.clear();
    for (const tool of snapshot.tools) this.tools.set(tool.callId, { ...tool });
    this.compactions = new Set(snapshot.compactions.map((item) => item.taskId));
    this.inbox = [...snapshot.inbox];
    this.observedTail = Math.max(this.observedTail, ...snapshot.entries.map((entry) => entry.id));
    await this.refreshQueue();
  }
  private async refreshQueue(): Promise<void> {
    const view = await this.sessionManager.conversation.viewState(context);
    try {
      const items = (view.value.docs["pi.inbox"] as unknown as { items: InboxItem[] }).items;
      this.inbox = items.map((item) => ({ id: item.id, mode: item.mode }));
      const queued: QueuedPrompt[] = [];
      for (const item of items) {
        if (item.mode === "write") continue;
        const submission = await this.sessionManager.harness.submission(item.id, context);
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
      case "message_end":
        await this.sessionManager.observeEntries([event.entry]);
        this.observedTail = Math.max(this.observedTail, event.entry.id);
        if (event.type === "entry_appended")
          this.emit({ type: "entry_appended", entry: event.entry } as unknown as AgentSessionEvent);
        else
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
        await this.resources.extensionRunner.emit({ type: "agent_start" });
        this.emit({ type: "agent_start" });
        break;
      case "run_end":
        this.busy = false;
        this.partial = undefined;
        this.handoffRequested = false;
        await this.resources.extensionRunner.emit({ type: "agent_end", messages: this.messages });
        this.emit({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent);
        this.settlementPending = true;
        break;
      case "tool_execution_start":
        this.tools.set(event.toolCallId, {
          callId: event.toolCallId,
          name: event.toolName,
          status: "running",
        });
        this.emit(event);
        break;
      case "tool_execution_update": {
        const tool = this.tools.get(event.toolCallId)!;
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
        this.tools.delete(event.toolCallId);
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
        this.emit(event as unknown as AgentSessionEvent);
        break;
      case "auto_retry_end":
        this.emit({ ...event, success: true } as AgentSessionEvent);
        break;
      case "task_failed":
        this.errors.push(new Error(`${event.kind}: ${event.message}`));
        break;
    }
  }

  async refreshContext(): Promise<void> {
    await this.sessionManager.refresh();
  }
  private async prepare(): Promise<void> {
    if (this.closing) throw new Error("Session is closed");
    await this.refreshContext();
    this.refreshRegistry();
  }
  async prompt(text: string, options: AgentSessionPromptOptions = {}): Promise<PromptDisposition> {
    const preflight = new AbortController();
    this.preflights.add(preflight);
    const previous = this.admission;
    let release!: () => void;
    this.admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    let submission: Submission;
    try {
      await previous;
      if (this.closing) throw new Error("Session is closed");
      preflight.signal.throwIfAborted();
      await this.prepare();
      const prepared = await prepareDurablePrompt(this.resources, text, {
        ...options,
        signal: preflight.signal,
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
      if (!this.busy)
        await this.sessionManager.conversation.commit(async (tx) => {
          (await tx.doc(PromptDoc, this.sessionManager.conversation.id)).override =
            prepared.systemPrompt ?? null;
        }, context);
      for (const message of prepared.messages ?? [])
        await this.sessionManager.appendMessage(
          message as Parameters<SessionStore["appendMessage"]>[0],
        );
      preflight.signal.throwIfAborted();
      const content = prepared.images?.length
        ? [{ type: "text" as const, text: prepared.text }, ...prepared.images]
        : prepared.text;
      submission = await this.sessionManager.conversation.submit(
        {
          type: "input",
          content,
          requestId: options.clientMessageId ? `client:${options.clientMessageId}` : randomUUID(),
          whenBusy: options.streamingBehavior ?? "reject",
        },
        context,
      );
    } finally {
      this.preflights.delete(preflight);
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
  getQueuedPrompts(): QueuedPrompt[] {
    return this.queued;
  }
  async removeQueuedPrompt(kind: "steer" | "followUp", index: number): Promise<void> {
    const item = this.inbox.filter((entry) => entry.mode === kind)[index];
    if (!item) throw new Error("Queued prompt not found");
    await this.sessionManager.harness.abortSubmission(
      item.id,
      context,
      this.sessionManager.conversation.id,
    );
    await this.refreshQueue();
  }
  async reloadResources(): Promise<void> {
    if (this.busy) {
      this.reloadRequested = true;
      return;
    }
    await this.reloadResourcesNow();
  }
  private async reloadResourcesNow(): Promise<void> {
    await this.resources.reload();
    await this.sessionManager.conversation.commit(async (tx) => {
      (await tx.doc(PromptDoc, this.sessionManager.conversation.id)).override = null;
    }, context);
    this.refreshRegistry();
  }
  requestTurnEnd(): void {
    this.handoffRequested = true;
  }
  deferSettlement(): () => Promise<void> {
    this.completionHolds++;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      this.completionHolds--;
      await this.publishSettlement();
      await this.flushDelivery();
    };
  }
  private async publishSettlement(): Promise<void> {
    if (!this.settlementPending || this.busy || this.completionHolds) return;
    this.settlementPending = false;
    if (this.reloadRequested && !this.closing) {
      this.reloadRequested = false;
      await this.reloadResourcesNow();
    }
    this.emit({ type: "agent_settled" } as AgentSessionEvent);
  }
  private async waitForObservation(tail: number, idle = false): Promise<void> {
    await new Promise<void>((resolve) => {
      const wake = () => {
        if (!this.errors.length && (this.observedTail < tail || (idle && this.busy))) return;
        this.observerWaiters.delete(wake);
        resolve();
      };
      this.observerWaiters.add(wake);
      wake();
    });
  }
  async waitForIdle(): Promise<void> {
    if (this.closing && !this.busy) {
      await this.flushDelivery();
      return;
    }
    await this.sessionManager.conversation.waitForIdle(context);
    if (this.closing && !this.busy) {
      await this.flushDelivery();
      return;
    }
    await this.waitForObservation(0, true);
    await this.flushDelivery();
  }
  async abort(): Promise<void> {
    for (const preflight of this.preflights) preflight.abort();
    await this.sessionManager.conversation.abort(context);
    await this.waitForIdle();
  }
  abortCompaction(): void {
    for (const id of this.compactions)
      void this.sessionManager.harness
        .abortTask(id as never, context)
        .catch((error) => this.errors.push(error));
  }
  async compact(instructions?: string): Promise<void> {
    const id = await this.sessionManager.conversation.compact(instructions, context);
    const result = await this.sessionManager.harness.waitForTask(id, context);
    if (result.state.outcome.status === "completed") {
      const summary = result.state.outcome.result;
      let entryId = summary.entryId;
      if (summary.submissionId !== undefined) {
        const submission = await this.sessionManager.harness.submission(
          summary.submissionId,
          context,
        );
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
  private customIdentity(message: CustomSessionInput): string {
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
  private async admitCustomInput(
    message: CustomSessionInput,
    whenBusy: "steer" | "reject",
    identity: string,
    attempt = 0,
  ): Promise<Submission> {
    const submission = await this.sessionManager.conversation.submit(
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
  async queueCustomSteeringMessage(message: CustomSessionInput): Promise<void> {
    await this.prepare();
    await this.admitCustomInput(message, "steer", this.customIdentity(message));
    await this.refreshQueue();
  }
  async sendCustomMessage(
    message: CustomSessionInput,
    options: Parameters<AgentSessionController["sendCustomMessage"]>[1] = {},
  ): Promise<void> {
    await this.prepare();
    if (!options.triggerTurn) {
      const submission = await this.sessionManager.conversation.submit(
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
        await this.sessionManager.conversation.waitForIdle(context);
        submission = await this.admitCustomInput(message, "steer", identity, ++attempt);
      }
      await this.waitForIdle();
    }
    await this.flushDelivery();
  }
  dispose(): Promise<void> {
    return (this.closing ??= (async () => {
      for (const preflight of this.preflights) preflight.abort();
      await this.admission;
      await Promise.allSettled(this.preflightOperations);
      // Closing checkpoints unfinished work. Only abort withdraws accepted inputs.
      await this.sessionManager.close();
      if (this.started) await this.stream.stop();
      await this.flushDelivery();
      await this.resources.dispose();
    })());
  }
}
