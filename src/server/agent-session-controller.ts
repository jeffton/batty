import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { PromptDisposition, QueuedPrompt } from "@/shared/types";
import type { SessionStore } from "./session-store";

export interface AgentSessionPromptOptions {
  images?: ImageContent[];
  clientMessageId?: string;
  streamingBehavior?: "steer" | "followUp";
}

type CustomInput = {
  customType: string;
  content: string | Array<TextContent | ImageContent>;
  display: boolean;
  details?: Record<string, unknown>;
};
type ActiveTool = {
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult?: { content: unknown[]; details?: unknown };
};

/** Web-facing admission and delivery boundaries around Pi's coding-agent session. */
export class AgentSessionController {
  private readonly listeners = new Set<(event: AgentSessionEvent) => void | Promise<void>>();
  private readonly eventContext = new AsyncLocalStorage<boolean>();
  private readonly pendingEvents = new Set<Promise<void>>();
  private readonly eventErrors: unknown[] = [];
  private readonly tools = new Map<string, ActiveTool>();
  private readonly promptPreflights = new Set<AbortController>();
  private admission = Promise.resolve();
  private admitting = false;
  private endTurnRequested = false;
  private endingTurn = false;
  private closing?: Promise<void>;
  private readonly unsubscribe: () => void;

  private constructor(
    readonly sdk: AgentSession,
    readonly sessionManager: SessionStore,
  ) {
    const finishTurn = sdk.agent.finishTurn;
    sdk.agent.finishTurn = async (turn, signal) => {
      const decision = await finishTurn?.(turn, signal);
      if (!this.endTurnRequested) return decision ?? undefined;
      this.endTurnRequested = false;
      // Already-admitted input must be consumed, not stranded by the handoff.
      if (this.admitting || sdk.pendingMessageCount > 0) return decision ?? undefined;
      this.endingTurn = true;
      return { action: "end" };
    };
    this.unsubscribe = sdk.subscribe((event) => {
      if (event.type === "tool_execution_start") this.tools.set(event.toolCallId, event);
      if (event.type === "tool_execution_update") {
        const tool = this.tools.get(event.toolCallId);
        if (tool) tool.partialResult = event.partialResult;
      }
      if (event.type === "tool_execution_end") this.tools.delete(event.toolCallId);
      if (event.type === "agent_settled") {
        this.tools.clear();
        this.endTurnRequested = false;
        this.endingTurn = false;
      }
      // Pi emits message_end immediately before persisting it. Observe the completed
      // synchronous dispatch so UI projections and summaries see the durable entry.
      const delivery = Promise.resolve().then(() =>
        this.eventContext.run(true, async () => {
          if (
            [
              "entry_appended",
              "message_end",
              "session_info_changed",
              "thinking_level_changed",
              "compaction_end",
            ].includes(event.type)
          ) {
            sessionManager.publishSummary();
          }
          await Promise.all([...this.listeners].map((listener) => listener(event)));
        }),
      );
      this.pendingEvents.add(delivery);
      void delivery.then(
        () => this.pendingEvents.delete(delivery),
        (error) => {
          this.pendingEvents.delete(delivery);
          this.eventErrors.push(error);
        },
      );
    });
  }

  static async create(sdk: AgentSession, store: SessionStore): Promise<AgentSessionController> {
    return new AgentSessionController(sdk, store);
  }

  get sessionId() {
    return this.sdk.sessionId;
  }
  get sessionFile() {
    return this.sessionManager.getSessionFile();
  }
  get sessionName() {
    return this.sdk.sessionName;
  }
  get model() {
    return this.sdk.model;
  }
  get thinkingLevel() {
    return this.sdk.thinkingLevel;
  }
  get isStreaming() {
    return this.admitting || this.sdk.isStreaming;
  }
  get isCompacting() {
    return this.sdk.isCompacting;
  }
  get pendingMessageCount() {
    return this.sdk.pendingMessageCount;
  }
  get messages() {
    return this.sdk.messages;
  }
  get settingsManager() {
    return this.sdk.settingsManager;
  }
  get resourceLoader() {
    return this.sdk.resourceLoader;
  }
  get streamingMessage() {
    return this.sdk.state.streamingMessage;
  }
  get runningTools() {
    return [...this.tools.values()];
  }
  getAvailableThinkingLevels() {
    return this.sdk.getAvailableThinkingLevels();
  }
  getActiveToolNames() {
    return this.sdk.getActiveToolNames();
  }
  async setActiveToolsByName(names: string[]) {
    this.sdk.setActiveToolsByName(names);
  }
  async setModel(model: Model<Api>) {
    await this.sdk.setModel(model);
  }
  async setThinkingLevel(level: ThinkingLevel) {
    this.sdk.setThinkingLevel(level);
  }

  subscribe(listener: (event: AgentSessionEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Serialize preflight only; queued input can still be admitted while a turn runs. */
  private async admit<T>(
    run: (accepted: () => void) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closing) throw new Error("Session is closed");
    const previous = this.admission;
    let release!: () => void;
    this.admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    // After the end decision Pi skips queue polling. Admit new input after idle.
    if (this.endingTurn) await this.sdk.waitForIdle();
    this.admitting = true;
    let accepted = false;
    const finishAdmission = () => {
      if (accepted) return;
      accepted = true;
      this.admitting = false;
      release();
    };
    try {
      if (this.closing) throw new Error("Session is closed");
      signal?.throwIfAborted();
      return await run(finishAdmission);
    } finally {
      finishAdmission();
    }
  }

  async prompt(text: string, options: AgentSessionPromptOptions = {}): Promise<PromptDisposition> {
    const queuedInputId = randomUUID();
    let disposition: PromptDisposition = { disposition: "completed" };
    const preflight = new AbortController();
    this.promptPreflights.add(preflight);
    try {
      await this.admit(async (accepted) => {
        await this.sdk.prompt(text, {
          ...options,
          queuedInputId,
          signal: preflight.signal,
          preflightResult: (result) => {
            this.promptPreflights.delete(preflight);
            if (result === "queued")
              disposition = { disposition: "queued", entryId: queuedInputId };
            accepted();
          },
        });
      }, preflight.signal);
    } finally {
      this.promptPreflights.delete(preflight);
    }
    await this.flushEvents();
    return disposition;
  }

  getQueuedPrompts(): QueuedPrompt[] {
    return this.sdk.getQueuedPrompts();
  }
  async removeQueuedPrompt(kind: "steer" | "followUp", index: number): Promise<void> {
    this.sdk.removeQueuedPrompt(kind, index);
    await this.flushEvents();
  }

  /** End at the next completed tool batch without aborting its results. */
  requestTurnEnd(): void {
    this.endTurnRequested = true;
  }

  async waitForIdle(): Promise<void> {
    await this.sdk.waitForIdle();
    await this.flushEvents();
  }

  private async flushEvents(): Promise<void> {
    // A notification can itself start a turn or wait for idle; it cannot join itself.
    if (this.eventContext.getStore()) return;
    while (this.pendingEvents.size) await Promise.allSettled(this.pendingEvents);
    if (this.eventErrors.length) throw this.eventErrors.shift();
  }

  private cancelPromptPreflights(): void {
    for (const preflight of this.promptPreflights) preflight.abort();
    this.admitting = false;
  }

  async abort(): Promise<void> {
    this.cancelPromptPreflights();
    await this.sdk.abort();
    await this.flushEvents();
  }
  abortCompaction(): void {
    this.sdk.abortCompaction();
  }
  async compact(instructions?: string): Promise<void> {
    await this.sdk.compact(instructions);
    await this.flushEvents();
  }

  async queueCustomSteeringMessage(message: CustomInput): Promise<void> {
    if (this.endingTurn) {
      await this.sendCustomMessage(message, { triggerTurn: true, steerWhenBusy: true });
      return;
    }
    this.sdk.agent.steer({ role: "custom", ...message, timestamp: Date.now() } as AgentMessage);
  }

  async sendCustomMessage(
    message: CustomInput,
    options: {
      triggerTurn?: boolean;
      steerWhenBusy?: boolean;
      onAccepted?: () => void;
    } = {},
  ): Promise<void> {
    const deliveryId = randomUUID();
    const input = {
      ...message,
      details: { ...(message.details as Record<string, unknown>), battyDeliveryId: deliveryId },
    };
    let queued = false;
    await this.admit(async (accepted) => {
      queued = this.sdk.isStreaming && options.triggerTurn === true;
      if (queued && !options.steerWhenBusy) throw new Error("Session is busy");
      const run = this.sdk.sendCustomMessage(input, { triggerTurn: options.triggerTurn });
      options.onAccepted?.();
      accepted();
      await run;
    });
    if (queued) {
      // An abort can leave accepted steering in Pi's queue. Submit that delivery once idle.
      for (;;) {
        await this.sdk.waitForIdle();
        let retry = false;
        await this.admit(async (accepted) => {
          if (this.sdk.isStreaming) {
            retry = true;
            accepted();
            return;
          }
          const index = this.sdk.agent
            .getQueuedMessages("steer")
            .findIndex(
              (item) =>
                item.role === "custom" &&
                (item.details as Record<string, unknown>)?.battyDeliveryId === deliveryId,
            );
          if (index === -1) {
            accepted();
            return;
          }
          this.sdk.agent.removeQueuedMessage("steer", index);
          const run = this.sdk.sendCustomMessage(input, { triggerTurn: true });
          accepted();
          await run;
        });
        if (!retry) break;
      }
    }
    await this.flushEvents();
  }

  dispose(): Promise<void> {
    return (this.closing ??= (async () => {
      this.cancelPromptPreflights();
      await this.sdk.abort();
      await this.admission;
      await this.sdk.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      await this.flushEvents();
      this.unsubscribe();
      this.sdk.dispose();
      this.sessionManager.release();
    })());
  }
}
