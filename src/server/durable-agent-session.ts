import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, awaitWithContext } from "@earendil-works/chord/context";
import type { AttachedReplicatedState, JsonValue } from "@earendil-works/chord";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, ToolCall } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { convertToLlm, estimateTokens } from "@earendil-works/pi-coding-agent";
import {
  AgentDoc,
  defineExtension,
  defineDoc,
  GenerationTask,
  CompactionTask,
  hook,
  section,
  watchEvents,
  type AgentEventStream,
  type ConversationView,
  type AgentState,
  type InboxState,
  type LiveState,
  type SubmissionId,
  type Submission,
  type SubmissionRecord,
  type CommitPublication,
} from "@earendil-works/pi-durable";
import type { PromptDisposition, QueuedPrompt } from "@/shared/types";
import type {
  AgentSessionController,
  AgentSessionPromptOptions,
  CustomSessionInput,
  SessionControllerEvent,
} from "./agent-session-controller";
import { createDurableToolExtension } from "./durable-tools";
import type { SessionResources } from "./session-resources";
import { SessionStore } from "./session-store";
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
  private readonly listeners = new Set<(event: SessionControllerEvent) => void | Promise<void>>();
  private readonly deliveryContext = new AsyncLocalStorage<boolean>();
  private readonly deliveries = new Set<Promise<void>>();
  private readonly errors: unknown[] = [];
  private stream!: AgentEventStream;
  private state!: AttachedReplicatedState<ConversationView>;
  /** Semantic delivery cursor, not presentation state. */
  private observedRun?: SubmissionId;
  private semanticTail = Promise.resolve();
  private semanticWork = 0;
  private unsubscribeCommits?: () => void;
  private unsubscribeLifecycle?: () => void;
  private readonly semanticScope = new AsyncLocalStorage<{
    agent: AgentState;
    messages: AgentMessage[];
  }>();
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
  regularToolNames = new Set<string>();

  private constructor(
    readonly resources: SessionResources,
    readonly sessionManager: SessionStore,
  ) {}

  static async open(
    resources: SessionResources,
    store: SessionStore,
    model: Model<Api>,
    thinkingLevel: ThinkingLevel,
  ) {
    const controller = new DurableAgentSessionController(resources, store);
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
      thinkingLevel: clampThinkingLevel(model, thinkingLevel),
    });
    controller.refreshRegistry();
    controller.state = await store.conversation.viewState(context);
    return controller;
  }

  /** Bind resources before resuming recovered work. */
  async start(): Promise<void> {
    this.resources.bind({
      actions: {
        sendMessage: (message, options) =>
          this.trackOperation(
            this.semanticScope.exit(() =>
              this.sendCustomMessage(message as CustomSessionInput, {
                ...options,
                steerWhenBusy: true,
              }),
            ),
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
          this.trackOperation(
            this.semanticScope.exit(() =>
              this.prompt(text, { images, streamingBehavior: options?.deliverAs }),
            ),
          );
        },
        appendEntry: (customType, data) =>
          this.trackOperation(
            this.semanticScope.exit(() => this.sessionManager.appendCustomEntry(customType, data)),
          ),
        setSessionName: (name) =>
          this.trackOperation(
            this.semanticScope.exit(() => this.sessionManager.setSessionName(name)),
          ),
        getSessionName: () => this.sessionName,
        setLabel: (entryId, label) =>
          this.trackOperation(
            this.semanticScope.exit(() => this.sessionManager.setLabel(entryId, label)),
          ),
        setModel: async (model) => {
          await this.semanticScope.exit(() => this.setModel(model));
          return true;
        },
        getThinkingLevel: () =>
          this.semanticScope.getStore()?.agent.thinkingLevel ?? this.thinkingLevel,
        setThinkingLevel: (level) =>
          this.trackOperation(this.semanticScope.exit(() => this.setThinkingLevel(level))),
      },
      context: {
        getModel: () => {
          const ref = this.semanticScope.getStore()?.agent.model;
          return ref ? this.resources.modelRuntime.getModel(ref.provider, ref.modelId) : this.model;
        },
        getScopedModels: () => [],
        isIdle: () => !this.isStreaming && !this.isCompacting,
        getSignal: () => undefined,
        hasPendingMessages: () => this.pendingMessageCount > 0,
        getContextUsage: () => getSessionContextUsage(this),
        compact: (options) =>
          this.trackOperation(
            this.semanticScope
              .exit(() => this.compact(options?.customInstructions))
              .then(
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
        abort: () => this.trackOperation(this.semanticScope.exit(() => this.abort())),
        shutdown: () => {
          void this.semanticScope.exit(() => this.dispose());
        },
      },
      getMessages: () => this.semanticScope.getStore()?.messages ?? this.messages,
      toolsChanged: () => this.semanticScope.exit(() => this.configureTools()),
    });
    await this.resources.start();
    await this.configureTools();
    this.stream = await watchEvents(
      this.sessionManager.harness,
      this.sessionManager.conversation.id,
      context,
    );
    await this.sessionManager.observeEntries(this.stream.snapshot.entries);
    this.observedTail = this.stream.snapshot.entries.reduce(
      (tail, entry) => Math.max(tail, entry.id),
      0,
    );
    this.unsubscribeCommits = this.sessionManager.harness.subscribeCommits((publication) => {
      this.captureCommittedEvents(publication);
    });
    let previousRun: LiveState["run"];
    // This callback must remain synchronous: it captures native immutable frames,
    // never waits for hooks, and cannot acquire a bounded subscriber backlog.
    this.unsubscribeLifecycle = this.state.subscribe((view) => {
      const nextRun = (view.docs["pi.live"] as LiveState | undefined)?.run;
      if (previousRun?.inputs[0] === nextRun?.inputs[0]) return;
      const ended = previousRun;
      previousRun = nextRun;
      this.queueSemantic(async () => {
        const agent = view.docs["pi.agent"] as AgentState;
        if (ended) {
          const nextInput = nextRun?.inputs
            .map((id) => this.sessionManager.getSubmissionRecord(id)?.entry)
            .filter((id): id is NonNullable<typeof id> => id !== undefined)
            .reduce((first, id) => Math.min(first, id), Number.POSITIVE_INFINITY);
          const messages = this.messagesAt(
            view,
            nextInput === undefined ? undefined : nextInput - 1,
          );
          this.observedRun = undefined;
          this.handoffRequested = false;
          await this.semanticScope.run({ agent, messages }, () =>
            this.resources.extensionRunner.emit({ type: "agent_end", messages }),
          );
          this.emit({ type: "run_end", inputs: ended.inputs });
          this.settlementPending = true;
        }
        if (nextRun) {
          this.observedRun = nextRun.inputs[0];
          this.settlementPending = false;
          this.handoffRequested = false;
          await this.semanticScope.run({ agent, messages: this.messagesAt(view) }, () =>
            this.resources.extensionRunner.emit({ type: "agent_start" }),
          );
          this.emit({ type: "run_start", inputs: nextRun.inputs });
        }
      });
    });
    this.stream.start(async (events) => {
      for (const event of events) {
        if (
          event.type === "run_start" ||
          event.type === "run_end" ||
          event.type === "message_end" ||
          event.type === "entry_appended" ||
          event.type === "task_failed" ||
          event.type === "snapshot"
        )
          continue;
        this.emit(event);
      }
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
          await SessionStore.withSource(this.sessionFile, async (source) => {
            await source.conversation.commit(
              (tx) =>
                tx.appendEntry(source.conversation.id, {
                  kind: "batty.tool-artifacts",
                  data: JSON.parse(
                    JSON.stringify({ toolCallId, toolTaskId, details }),
                  ) as JsonValue,
                }),
              context,
            );
            await source.refresh();
            source.publishSummary();
          });
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
  get model(): Model<Api> {
    const ref = (this.view.docs["pi.agent"] as AgentState).model!;
    const model = this.resources.modelRuntime.getModel(ref.provider, ref.modelId);
    if (!model) throw new Error(`Unknown session model: ${ref.provider}/${ref.modelId}`);
    return model;
  }
  get thinkingLevel(): ThinkingLevel {
    return (this.view.docs["pi.agent"] as AgentState).thinkingLevel!;
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
  get view(): ConversationView {
    return this.state.value;
  }
  private get live(): LiveState {
    return (this.view.docs["pi.live"] ?? {}) as LiveState;
  }
  private get inbox(): InboxState["items"] {
    return ((this.view.docs["pi.inbox"] ?? { items: [] }) as InboxState).items;
  }
  get isStreaming() {
    return this.live.run !== undefined;
  }
  get isClosing() {
    return this.closing !== undefined;
  }
  get isCompacting() {
    return (this.live.compactions?.length ?? 0) > 0;
  }
  get pendingMessageCount() {
    return this.inbox.filter((item) => item.mode !== "write").length;
  }
  get streamingMessage() {
    return this.live.generation?.message as AssistantMessage | undefined;
  }
  get runningTools() {
    return (this.live.tools ?? [])
      .filter((tool) => tool.status !== "done")
      .map((tool) => ({
        toolCallId: tool.callId,
        toolName: tool.name,
        args:
          this.messages
            .filter((message) => message.role === "assistant")
            .flatMap((message) => message.content)
            .findLast(
              (block): block is ToolCall => block.type === "toolCall" && block.id === tool.callId,
            )?.arguments ?? {},
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
  }
  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    const selected = clampThinkingLevel(this.model, level);
    await this.sessionManager.configure({ thinkingLevel: selected });
  }
  subscribe(listener: (event: SessionControllerEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(event: SessionControllerEvent): void {
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
  /** Capture table receipts losslessly; no Session API or hook runs on the commit line. */
  private captureCommittedEvents(publication: CommitPublication): void {
    const changes = publication.changes.filter(
      (change) =>
        (change.type === "entry" || change.type === "task") &&
        change.value.conversationId === this.sessionManager.conversation.id,
    );
    const entries = changes
      .filter((change) => change.type === "entry")
      .map((change) => change.value)
      .sort((left, right) => left.id - right.id);
    if (entries.length)
      this.queueSemantic(async () => {
        await this.sessionManager.observeEntries(entries);
        for (const entry of entries) {
          this.observedTail = Math.max(this.observedTail, entry.id);
          this.emit({ type: entry.model?.length ? "message_end" : "entry_appended", entry });
        }
      });
    for (const change of changes) {
      if (change.type !== "task") continue;
      const task = change.value;
      const state = task.state;
      if (state.status !== "terminal") continue;
      const outcome = state.outcome;
      if (outcome.status !== "faulted" && outcome.status !== "orphaned") continue;
      const message = outcome.status === "faulted" ? outcome.error.message : outcome.reason;
      this.queueSemantic(async () => {
        this.errors.push(new Error(`${task.kind}: ${message}`));
        this.emit({ type: "task_failed", taskId: task.id, kind: task.kind, message });
      });
    }
  }

  private queueSemantic(operation: () => Promise<void>): void {
    this.semanticWork++;
    this.semanticTail = this.semanticTail
      .then(operation)
      .catch((error) => {
        this.errors.push(error);
      })
      .then(async () => {
        this.semanticWork--;
        if (!this.semanticWork) await this.publishSettlement();
        for (const wake of this.observerWaiters) wake();
      })
      .catch((error) => {
        this.errors.push(error);
        for (const wake of this.observerWaiters) wake();
      });
  }

  /** Native active records are immutable: delayed hooks see their captured frame, not future turns. */
  private messagesAt(
    view: ConversationView,
    throughEntryId = Number.POSITIVE_INFINITY,
  ): AgentMessage[] {
    const tail = view.entries.reduce((latest, entry) => Math.max(latest, entry.id), 0);
    const projected = new Map(
      this.sessionManager.getEntriesUpTo(tail).map((entry) => [entry.id, entry]),
    );
    return structuredClone(
      view.entries
        .filter((entry) => entry.id <= throughEntryId)
        .flatMap((entry) =>
          (entry.model ?? []).map((message, index) => {
            const source = projected.get(index ? `${entry.id}:${index}` : String(entry.id));
            if (source?.type === "message") return source.message;
            if (source?.type === "custom_message")
              return {
                role: "custom",
                customType: source.customType,
                content: source.content,
                display: source.display,
                details: source.details,
                timestamp: Date.parse(source.timestamp),
              } as AgentMessage;
            return message as AgentMessage;
          }),
        ),
    );
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
      if (!this.isStreaming)
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
    if (status.status === "queued") {
      return { disposition: "queued", entryId: String(submission.id) };
    }
    await submission.wait(context);
    await this.waitForIdle();
    return { disposition: "completed" };
  }
  getQueuedPrompts(): QueuedPrompt[] {
    const indexes = { steer: 0, followUp: 0 };
    return this.inbox.flatMap((item) => {
      if (item.mode === "write") return [];
      const requestId = this.sessionManager.getSubmissionRecord(item.id)?.requestId;
      return [
        {
          submissionId: item.id,
          kind: item.mode,
          index: indexes[item.mode]++,
          text:
            typeof item.content === "string"
              ? item.content
              : item.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n"),
          clientMessageId: requestId?.startsWith("client:") ? requestId.slice(7) : undefined,
        },
      ];
    });
  }
  async removeQueuedPrompt(submissionId: number): Promise<void> {
    const item = this.inbox.find((entry) => entry.mode !== "write" && entry.id === submissionId);
    if (!item) throw new Error("Queued prompt not found");
    await this.sessionManager.harness.abortSubmission(
      item.id,
      context,
      this.sessionManager.conversation.id,
    );
  }
  async reloadResources(): Promise<void> {
    if (this.isStreaming) {
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
    if (!this.settlementPending || this.isStreaming || this.completionHolds || this.semanticWork)
      return;
    this.settlementPending = false;
    if (this.reloadRequested && !this.closing) {
      this.reloadRequested = false;
      await this.reloadResourcesNow();
    }
    this.emit({ type: "agent_settled" });
  }
  private async waitForObservation(tail: number, idle = false): Promise<void> {
    await new Promise<void>((resolve) => {
      const wake = () => {
        if (
          !this.errors.length &&
          (this.observedTail < tail ||
            (idle && (this.observedRun !== undefined || this.semanticWork > 0)))
        )
          return;
        this.observerWaiters.delete(wake);
        resolve();
      };
      this.observerWaiters.add(wake);
      wake();
    });
  }
  async waitForIdle(): Promise<void> {
    if (this.closing && !this.isStreaming) {
      await this.semanticTail;
      await this.flushDelivery();
      return;
    }
    await this.sessionManager.conversation.waitForIdle(context);
    if (this.closing && !this.isStreaming) {
      await this.semanticTail;
      await this.flushDelivery();
      return;
    }
    await this.waitForObservation(Math.max(0, ...this.view.entries.map((entry) => entry.id)), true);
    await this.flushDelivery();
  }
  async abort(): Promise<void> {
    for (const preflight of this.preflights) preflight.abort();
    await this.sessionManager.conversation.abort(context);
    await this.waitForIdle();
  }
  abortCompaction(): void {
    for (const { taskId: id } of this.live.compactions ?? [])
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
  getCustomInputSubmission(
    message: Parameters<AgentSessionController["getCustomInputSubmission"]>[0],
    attempt = 0,
  ): Promise<SubmissionRecord | undefined> {
    return this.sessionManager.storage.submissionByRequest(
      this.sessionManager.conversation.id,
      `custom-input:${this.customIdentity(message)}:${attempt}`,
      context,
    );
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
    return submission;
  }
  async queueCustomSteeringMessage(message: CustomSessionInput): Promise<void> {
    await this.prepare();
    await this.admitCustomInput(message, "steer", this.customIdentity(message));
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
      this.unsubscribeCommits?.();
      this.unsubscribeLifecycle?.();
      if (!this.isStreaming) await this.semanticTail;
      this.state.dispose();
      await this.flushDelivery();
      await this.resources.dispose();
    })());
  }
}
