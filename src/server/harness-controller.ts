import { setTimeout as delay } from "node:timers/promises";
import {
  AgentHarness,
  NoActiveOperation,
  BACKGROUND_CONTEXT as context,
  createCompactionSummaryMessage,
  createBranchSummaryMessage,
  getOrThrow,
  formatSkillInvocation,
  formatPromptTemplateInvocation,
  parseCommandArgs,
  reduceLaneSnapshot,
  type AgentHarnessOptions,
  type AgentLane,
  type AgentMessage,
  type HarnessEvent,
  type LaneSnapshot,
  type ThinkingLevel,
  type WatchHandle,
} from "@earendil-works/pi-agent-core";
import {
  getSupportedThinkingLevels,
  type Api,
  type ImageContent,
  type Model,
} from "@earendil-works/pi-ai";
import type {
  AgentSessionEvent,
  ResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { HarnessSessionStore } from "./harness-session-store";

export interface HarnessPromptOptions {
  images?: ImageContent[];
  clientMessageId?: string;
  streamingBehavior?: "steer" | "followUp";
}

/** Application controller: Pi owns execution, queues, retries, compaction, and recovery. */
export class HarnessController {
  private readonly listeners = new Set<(event: AgentSessionEvent) => void | Promise<void>>();
  private watch!: WatchHandle<LaneSnapshot>;
  snapshot!: LaneSnapshot;
  private name?: string;
  private closing?: Promise<void>;
  private readonly drivers = new Map<string, Promise<void>>();
  private readonly closeSignal = new AbortController();

  private constructor(
    readonly harness: AgentHarness<any>,
    readonly lane: AgentLane,
    readonly sessionManager: HarnessSessionStore,
    private readonly options: AgentHarnessOptions<any>,
    readonly settingsManager: SettingsManager,
    readonly resourceLoader: ResourceLoader,
  ) {}

  static async create(
    store: HarnessSessionStore,
    options: Omit<AgentHarnessOptions<any>, "session">,
    settings: SettingsManager,
    resources: ResourceLoader,
  ): Promise<HarnessController> {
    const { harness } = await AgentHarness.create({ ...options, session: store.native }, context);
    try {
      const lane = await harness.lane("main", context);
      await store.attach(lane);
      const controller = new HarnessController(
        harness,
        lane,
        store,
        { ...options, session: store.native },
        settings,
        resources,
      );
      controller.name = await harness.getName(context);
      controller.watch = await lane.watch(context);
      controller.snapshot = controller.watch.snapshot;
      controller.watch.start((event) => controller.observe(event));
      return controller;
    } catch (error) {
      await harness.close(context);
      store.release();
      throw error;
    }
  }

  get sessionId(): string {
    return this.sessionManager.getSessionId();
  }
  get sessionFile(): string {
    return this.sessionManager.getSessionFile();
  }
  get sessionName(): string | undefined {
    return this.name;
  }
  get model(): Model<Api> | undefined {
    const model = this.snapshot.configuration.model;
    return this.options.models.getModel(model.provider, model.modelId);
  }
  get thinkingLevel(): ThinkingLevel {
    return this.snapshot.configuration.thinkingLevel;
  }
  get isStreaming(): boolean {
    return this.snapshot.operation !== null;
  }
  get pendingMessageCount(): number {
    return this.snapshot.queues.filter((item) => item.kind === "steer" || item.kind === "followUp")
      .length;
  }
  get messages(): AgentMessage[] {
    return this.snapshot.transcript.flatMap((entry): AgentMessage[] => {
      if (entry.type === "message") return [entry.message];
      if (entry.type === "compaction")
        return [
          createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
          ...entry.retainedTail,
        ];
      if (entry.type === "branch_summary")
        return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
      return [];
    });
  }
  getAvailableThinkingLevels(): ThinkingLevel[] {
    return this.model ? getSupportedThinkingLevels(this.model) : ["off"];
  }
  getActiveToolNames(): string[] {
    return this.snapshot.configuration.activeToolNames;
  }
  async setActiveToolsByName(names: string[]): Promise<void> {
    await this.lane.setActiveTools(names, context);
  }
  async setModel(model: Model<Api>): Promise<void> {
    await this.lane.setModel({ provider: model.provider, modelId: model.id }, context);
  }
  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.lane.setThinkingLevel(level, context);
  }
  async waitForIdle(): Promise<void> {
    await this.lane.waitForIdle(context);
    // The owning callers receive operation failures; idle waiters only join settlement.
    await Promise.allSettled(this.drivers.values());
  }

  subscribe(listener: (event: AgentSessionEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async observe(event: HarnessEvent): Promise<void> {
    const reduction = reduceLaneSnapshot(this.snapshot, event);
    if (reduction === "rebase") {
      this.snapshot = await this.watch.resnapshot(context);
      await this.sessionManager.refresh();
    }
    this.sessionManager.setCurrentOperation(this.snapshot.operation?.id);
    if (event.type === "entry_added") this.sessionManager.observe(event.entry);
    else if (
      [
        "run_start",
        "run_end",
        "operation_abort",
        "value_update",
        "config_update",
        "queue_update",
      ].includes(event.type)
    )
      this.sessionManager.publishSummary();
    this.sessionManager.setTip(this.snapshot.tipId);
    if (event.type === "value_update" && event.value === "session_name") this.name = event.name;
    if (event.type === "fault") throw new Error(`Pi harness fault ${event.code}: ${event.message}`);
    if (event.type === "handler_error") console.error("Pi harness handler failed", event);
    const adapted = adaptHarnessEvent(event);
    if (adapted) for (const listener of this.listeners) await listener(adapted);
  }

  async prompt(text: string, options: HarnessPromptOptions = {}): Promise<void> {
    if (text.startsWith("/")) {
      const [command, ...args] = parseCommandArgs(text.slice(1));
      const resources = await this.harness.getResources(context);
      if (command?.startsWith("skill:")) {
        const skill = resources.skills?.find((skill) => skill.name === command.slice(6));
        if (!skill) throw new Error(`Unknown skill: ${command.slice(6)}`);
        text = formatSkillInvocation(skill, args.join(" "));
      } else {
        const template = resources.promptTemplates?.find((template) => template.name === command);
        if (template) text = formatPromptTemplateInvocation(template, args);
      }
    }
    const message: AgentMessage = {
      role: "user",
      content: [{ type: "text", text }, ...(options.images ?? [])],
      timestamp: Date.now(),
      ...(options.clientMessageId ? { clientMessageId: options.clientMessageId } : {}),
    };
    if (this.isStreaming) {
      if (!options.streamingBehavior) throw new Error("Session is busy; choose steer or followUp");
      getOrThrow(await this.lane[options.streamingBehavior](message, undefined, context));
      return;
    }
    const admission = getOrThrow(
      await this.lane.accept({ kind: "prompt", prompt: message }, context),
    );
    await this.drive(admission.operationId);
  }
  async resume(): Promise<void> {
    const current = (await this.lane.inspectExecution(context)).current;
    if (current) await this.drive(current.id);
  }
  private drive(operationId: string): Promise<void> {
    const existing = this.drivers.get(operationId);
    if (existing) return existing;
    const driving = this.driveUntilSettled(operationId).finally(() =>
      this.drivers.delete(operationId),
    );
    this.drivers.set(operationId, driving);
    return driving;
  }
  private async driveUntilSettled(operationId: string): Promise<void> {
    for (;;) {
      const result = getOrThrow(
        await this.lane.drive({ operationId, waitForRetry: true, pollDeferred: true }, context),
      );
      if (result.kind === "settled") {
        if (result.outcome.status === "failed") throw new Error(result.outcome.error!.message);
        return;
      }
      const wait =
        result.reason === "retry"
          ? Math.max(0, result.notBefore - Date.now())
          : Math.max(1000, result.deferred.pollAfterMs ?? 0);
      await delay(wait, undefined, { signal: this.closeSignal.signal });
    }
  }
  async abort(): Promise<void> {
    const result = await this.lane.abort(context);
    if (!result.ok && !(result.error instanceof NoActiveOperation)) throw result.error;
  }
  abortCompaction(): void {
    void this.abort().catch((error) => console.error("Failed to abort compaction", error));
  }
  async compact(customInstructions?: string): Promise<void> {
    const result = getOrThrow(await this.lane.compact({ customInstructions }, context));
    if (result.compaction.status === "failed") throw new Error(result.compaction.error!.message);
  }
  async sendCustomMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options: { triggerTurn?: boolean } = {},
  ): Promise<void> {
    const custom = { ...message, role: "custom", timestamp: Date.now() } as AgentMessage;
    if (!options.triggerTurn) {
      await this.sessionManager.appendMessage(custom);
      return;
    }
    const admission = getOrThrow(
      await this.lane.accept({ kind: "prompt", prompt: custom }, context),
    );
    await this.drive(admission.operationId);
  }
  getSteeringMessages(): string[] {
    return this.queuedTexts("steer");
  }
  getFollowUpMessages(): string[] {
    return this.queuedTexts("followUp");
  }
  private queuedTexts(kind: "steer" | "followUp"): string[] {
    return this.snapshot.queues.flatMap((item) =>
      item.kind === kind && item.type === "message" ? [messageText(item.message)] : [],
    );
  }
  async removeQueuedPrompt(kind: "steer" | "followUp", index: number): Promise<void> {
    const item = this.snapshot.queues.filter((item) => item.kind === kind)[index];
    if (!item) throw new Error("Queued prompt not found");
    getOrThrow(await this.lane.cancelQueued(item.entryId, context));
  }
  dispose(): Promise<void> {
    this.closeSignal.abort();
    return (this.closing ??= this.harness.close(context).finally(() => {
      this.watch.unsubscribe();
      this.sessionManager.release();
    }));
  }
}

function messageText(message: AgentMessage): string {
  if (!("content" in message)) return "";
  return typeof message.content === "string"
    ? message.content
    : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** Keep Batty's transport envelope, not the legacy execution lifecycle. */
function adaptHarnessEvent(event: HarnessEvent): AgentSessionEvent | undefined {
  switch (event.type) {
    case "run_start":
      return { type: "agent_start" };
    case "run_end":
      return { type: "agent_end", messages: [], willRetry: false };
    case "message_start":
      return { type: "message_start", message: event.message };
    case "message_update":
      return { type: "message_update", message: event.message, assistantMessageEvent: event.event };
    case "entry_added":
      return event.entry.type === "message"
        ? { type: "message_end", message: event.entry.message }
        : undefined;
    case "tool_start":
      return { ...event, type: "tool_execution_start" };
    case "tool_update":
      return { ...event, type: "tool_execution_update", args: undefined };
    case "tool_end":
      return { ...event, type: "tool_execution_end" };
    case "queue_update":
      return { type: "queue_update", steering: [], followUp: [] } as AgentSessionEvent;
    default:
      return undefined;
  }
}
