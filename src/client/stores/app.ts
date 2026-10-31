import { defineStore } from "pinia";
import { blockAppReload, checkAppUpdate } from "@/client/lib/app-updates";
import { primeAgentNotifications } from "@/client/lib/agent-notifications";
import { syncPushSubscription, unregisterPushSubscription } from "@/client/lib/push-notifications";
import { withBaseUrl } from "@/client/lib/base-url";
import { reportBrowserError } from "@/client/lib/browser-errors";
import { applyAppAppearance } from "@/client/lib/appearance";
import * as api from "@/client/lib/api";
import { applyServerEvent, applySessionResponse } from "@/client/lib/session-events";
import { prependHistoryPage } from "@/client/lib/session-pagination";
import { createSessionConnection } from "@/client/lib/session-connection";
import { recentSessionWindow } from "@/client/lib/session-window";
import { sessionHistoryCursor } from "@/client/lib/session-stream";
import { createAppState } from "./app-state";
import { providerSettingsActions } from "./app-provider-settings";
import type { BootstrapPayload } from "@/shared/types";
import {
  clearMainCache,
  readMainCache,
  saveMainCache,
  CACHE_DAY_MS,
  CACHE_EPOCH_KEY,
  REVOKED_CACHE_SCOPE_KEY,
  registerMainCacheBootstrap,
  authorizePreviewCache,
  CacheSuspendedError,
} from "@/client/lib/main-cache";
let cachedBootstrap: BootstrapPayload | undefined;
let cacheError: string | undefined;
let cacheTimer: ReturnType<typeof setTimeout> | undefined;
let cacheSubscribed = false;
let connection: ReturnType<typeof createSessionConnection> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let expandedHistory = false;
let readingHistory: AbortController | undefined;
let readingHistoryError: string | undefined;
let uploads = 0;
let pushSync: Promise<void> | undefined;
let pushError: string | undefined;
let bootstrapping: Promise<void> | undefined;
blockAppReload(() => uploads > 0);
export const useAppStore = defineStore("app", {
  state: createAppState,
  actions: {
    ...providerSettingsActions,
    async bootstrap() {
      if (bootstrapping) return bootstrapping;
      bootstrapping = this.loadBootstrap().finally(() => {
        bootstrapping = undefined;
      });
      return bootstrapping;
    },
    async loadBootstrap() {
      if (!cacheSubscribed) {
        cacheSubscribed = true;
        navigator.serviceWorker?.addEventListener("controllerchange", () => {
          if (cachedBootstrap) authorizePreviewCache(cachedBootstrap);
        });
        window.addEventListener("storage", (event) => {
          if (event.key !== CACHE_EPOCH_KEY) return;
          cachedBootstrap = undefined;
          clearTimeout(cacheTimer);
          cacheTimer = undefined;
          this.closeStream();
          this.authenticated = false;
          this.activeSession = undefined;
          this.connectionState = "offline";
        });
        this.$subscribe(
          () => {
            if (cacheTimer !== undefined) return;
            cacheTimer = setTimeout(() => {
              cacheTimer = undefined;
              void this.persistMainCache();
            }, 1000);
          },
          { detached: true },
        );
      }
      let cacheReadError: unknown;
      let authEpoch = localStorage.getItem(CACHE_EPOCH_KEY);
      if (!this.bootstrapped) {
        try {
          const cached = await readMainCache();
          if (cached) {
            if (authEpoch !== localStorage.getItem(CACHE_EPOCH_KEY)) return;
            cachedBootstrap = cached.bootstrap;
            this.authenticated = true;
            this.bootstrapped = true;
            this.settings = cached.bootstrap.settings;
            this.models = cached.bootstrap.models;
            this.workspaces = cached.bootstrap.workspaces;
            this.auth = cached.bootstrap.auth;
            this.providerAuth = cached.bootstrap.providerAuth;
            this.activeSession = cached.session;
            this.connectionState = "offline";
            applyAppAppearance(this.settings.appearance);
          }
        } catch (error) {
          if (!(error instanceof CacheSuspendedError))
            this.lastError = `Local cache: ${String(error)}`;
          cacheReadError = error;
        }
      }
      authEpoch = localStorage.getItem(CACHE_EPOCH_KEY);
      try {
        const payload = await api.getBootstrap();
        if (payload.authenticated && cacheReadError)
          reportBrowserError(cacheReadError, "cache-read");
        if (payload.cacheScope === localStorage.getItem(REVOKED_CACHE_SCOPE_KEY))
          payload.authenticated = false;
        if (authEpoch !== localStorage.getItem(CACHE_EPOCH_KEY)) return;
        if (cachedBootstrap?.cacheScope && cachedBootstrap.cacheScope !== payload.cacheScope) {
          this.activeSession = undefined;
          this.authenticated = false;
          authEpoch = crypto.randomUUID();
          const replacementEpoch = await clearMainCache(authEpoch);
          if (replacementEpoch !== localStorage.getItem(CACHE_EPOCH_KEY)) return;
          authEpoch = replacementEpoch;
          this.activeSession = undefined;
        }
        if (payload.authenticated) registerMainCacheBootstrap();
        cachedBootstrap = payload.authenticated ? payload : undefined;
        if (cachedBootstrap) authorizePreviewCache(cachedBootstrap);
        this.authenticated = payload.authenticated;
        this.bootstrapped = true;
        this.auth = payload.auth;
        this.providerAuth = payload.providerAuth;
        this.settings = payload.settings;
        this.models = payload.models;
        applyAppAppearance(this.settings.appearance);
        if (this.authenticated) {
          this.workspaces = payload.workspaces;
          if (authEpoch !== localStorage.getItem(CACHE_EPOCH_KEY)) return;
          const incoming = await api.getMain(sessionHistoryCursor(this.activeSession));
          if (authEpoch !== localStorage.getItem(CACHE_EPOCH_KEY)) return;
          this.activeSession = applyServerEvent(this.activeSession, {
            type: "reset",
            state: incoming,
            streamId: incoming.streamId,
            revision: incoming.revision,
          });
          if (!expandedHistory) this.activeSession = recentSessionWindow(this.activeSession);
          this.openStream();
          void this.populateReadingCache();
          void this.syncNotifications();
        } else {
          this.closeStream();
          this.activeSession = undefined;
          authEpoch = crypto.randomUUID();
          await clearMainCache(authEpoch);
        }
        this.bootstrapFailed = false;
        this.lastError = undefined;
      } catch (error) {
        if (authEpoch !== localStorage.getItem(CACHE_EPOCH_KEY)) return;
        this.bootstrapFailed = true;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.connectionState = "offline";
        if (this.authenticated && this.activeSession) {
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            void this.recoverConnection();
          }, 3000);
        }
      }
    },
    async persistMainCache() {
      if (!cachedBootstrap || !this.authenticated || !this.activeSession) return;
      try {
        await saveMainCache(cachedBootstrap, this.activeSession);
        if (cacheError && this.lastError === cacheError) this.lastError = undefined;
        cacheError = undefined;
      } catch (error) {
        reportBrowserError(error, "cache-write");
        if (error instanceof CacheSuspendedError) return;
        cacheError = `Local cache: ${String(error)}`;
        this.lastError = cacheError;
      }
    },
    pauseReadingCache() {
      readingHistory?.abort();
      readingHistory = undefined;
    },
    async populateReadingCache() {
      if (
        readingHistory ||
        !this.authenticated ||
        document.visibilityState === "hidden" ||
        !navigator.onLine
      )
        return;
      const controller = new AbortController();
      readingHistory = controller;
      const sessionId = this.activeSession?.sessionId;
      const authEpoch = localStorage.getItem(CACHE_EPOCH_KEY);
      const current = () =>
        !controller.signal.aborted &&
        this.authenticated &&
        localStorage.getItem(CACHE_EPOCH_KEY) === authEpoch &&
        this.activeSession?.sessionId === sessionId;
      try {
        while (
          current() &&
          this.activeSession?.hasMoreMessages &&
          (this.activeSession.messages[0]?.timestamp ?? 0) > Date.now() - CACHE_DAY_MS
        ) {
          const requested = this.activeSession;
          const before = requested.messages[0]?.id;
          const page = await api.getMainMessages({ before, limit: 500, signal: controller.signal });
          if (!current()) return;
          if (readingHistoryError && this.lastError === readingHistoryError)
            this.lastError = undefined;
          readingHistoryError = undefined;
          if (!page.messages.length) break;
          this.activeSession = prependHistoryPage(this.activeSession!, requested, page);
          if (this.activeSession.messages[0]?.id === before) break;
          await this.persistMainCache();
        }
        if (current()) await this.persistMainCache();
      } catch (error) {
        // Only our lifecycle cancellation is expected. Timeouts, HTTP errors and
        // unowned browser aborts remain visible and retain fetch diagnostics.
        if (current()) {
          readingHistoryError = `Reading history: ${String(error)}`;
          this.lastError = readingHistoryError;
        }
      } finally {
        if (readingHistory === controller) readingHistory = undefined;
      }
    },
    async recoverConnection() {
      if (this.bootstrapFailed || !this.bootstrapped || !this.activeSession) await this.bootstrap();
      else if (this.authenticated) {
        if (connection) connection.recover();
        else this.openStream();
        void this.populateReadingCache();
        void this.syncNotifications(true);
      }
    },
    async checkForUpdates(buildId?: string) {
      try {
        await checkAppUpdate(buildId);
      } catch {
        // Background update failures are recorded by fetch diagnostics, not the chat banner.
        return;
      }
      // Resume may have attempted bootstrap while the backend was restarting.
      if (this.bootstrapFailed) await this.recoverConnection();
    },
    openStream() {
      this.closeStream();
      connection = createSessionConnection({
        path: () => {
          const after = sessionHistoryCursor(this.activeSession);
          return withBaseUrl(
            `/api/main/events${after ? `?after=${encodeURIComponent(after)}` : ""}`,
          );
        },
        onConnecting: () => {
          this.connectionState = "connecting";
        },
        onWatchdog: () => {
          // Retry a blocked reload locally; healthy streams never poll /api/version.
          if (this.serverBuildId) void this.checkForUpdates(this.serverBuildId);
        },
        onError: () => {
          this.connectionState = "offline";
        },
        onEvent: (event) => {
          if (event.type === "build") {
            this.serverBuildId = event.buildId;
            void this.checkForUpdates(event.buildId);
            return;
          }
          if (event.type === "auth-attempts") {
            this.providerAuthAttempts = Object.fromEntries(
              event.provider.map((attempt) => [attempt.attemptId, attempt]),
            );
            this.mcpAuthAttempts = Object.fromEntries(
              event.mcp.map((attempt) => [attempt.attemptId, attempt]),
            );
            this.authAttemptsVersion++;
            return;
          }
          if (event.type === "provider-auth-attempt") {
            this.providerAuthAttempts[event.attempt.attemptId] = event.attempt;
            return;
          }
          if (event.type === "mcp-auth-attempt") {
            this.mcpAuthAttempts[event.attempt.attemptId] = event.attempt;
            return;
          }
          if (event.type === "provider-usage") {
            this.providerUsage = event.update;
            return;
          }
          if (event.type === "orchestration-changed") {
            this.orchestrationVersion++;
            if (event.cron) this.cronVersion++;
            return;
          }
          if (event.type === "error") this.lastError = event.message;
          this.activeSession = applyServerEvent(this.activeSession, event);
          if (event.type === "reset") {
            this.connectionState = "online";
            void this.populateReadingCache();
          }
          if (!expandedHistory) this.activeSession = recentSessionWindow(this.activeSession);
        },
      });
      connection.open();
    },
    closeStream() {
      this.pauseReadingCache();
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      connection?.close();
      connection = undefined;
    },
    async logout() {
      expandedHistory = false;
      if (cachedBootstrap?.cacheScope)
        localStorage.setItem(REVOKED_CACHE_SCOPE_KEY, cachedBootstrap.cacheScope);
      cachedBootstrap = undefined;
      clearTimeout(cacheTimer);
      cacheTimer = undefined;
      await clearMainCache();
      await unregisterPushSubscription();
      await api.logout();
      this.closeStream();
      this.authenticated = false;
      this.activeSession = undefined;
      this.providerUsage = undefined;
      this.providerAuthAttempts = {};
      this.mcpAuthAttempts = {};
    },
    setAuthError(error: unknown) {
      this.authError = error instanceof Error ? error.message : String(error);
    },
    async syncNotifications(afterPending = false): Promise<void> {
      if (!this.authenticated || document.visibilityState === "hidden" || !navigator.onLine) return;
      if (pushSync) {
        await pushSync;
        // A request started before suspension can fail only after resume.
        // Recovery must synchronize again, not merely join that stale request.
        if (afterPending) return this.syncNotifications();
        return;
      }
      const epoch = localStorage.getItem(CACHE_EPOCH_KEY);
      pushSync = (async () => {
        try {
          await syncPushSubscription(false);
          if (epoch !== localStorage.getItem(CACHE_EPOCH_KEY)) return;
          if (pushError && this.lastError === pushError) this.lastError = undefined;
          pushError = undefined;
        } catch (error) {
          if (epoch !== localStorage.getItem(CACHE_EPOCH_KEY)) return;
          pushError = `Push notifications: ${error instanceof Error ? error.message : String(error)}`;
          this.lastError = pushError;
        }
      })().finally(() => {
        pushSync = undefined;
      });
      return pushSync;
    },
    primeNotifications() {
      void primeAgentNotifications()
        .then((granted) => {
          if (granted) return this.syncNotifications();
        })
        .catch((error) => {
          this.lastError = error instanceof Error ? error.message : String(error);
        });
    },
    async submitPrompt(
      mode: "prompt" | "steer",
      text: string,
      files: File[],
      clientMessageId: string,
    ) {
      if (this.connectionState !== "online" || !navigator.onLine)
        throw new Error("Offline — sending is disabled");
      this.primeNotifications();
      uploads += 1;
      try {
        return await api.submitMainPrompt(mode, text, files, clientMessageId);
      } finally {
        uploads -= 1;
      }
    },
    async stopActiveSession() {
      await api.stopMain();
    },
    async removeQueuedPrompt(kind: "steer" | "followUp", index: number) {
      const streamId = this.activeSession?.streamId;
      const response = await api.removeMainQueuedPrompt(kind, index);
      this.activeSession = applySessionResponse(this.activeSession, response, streamId);
    },
    async loadOlderMessages() {
      const current = this.activeSession;
      if (!current?.hasMoreMessages || this.loadingOlderMessages) return;
      this.loadingOlderMessages = true;
      try {
        const page = await api.getMainMessages({ before: current.messages[0]?.id, limit: 50 });
        if (this.activeSession) {
          const previous = this.activeSession;
          this.activeSession = prependHistoryPage(previous, current, page);
          if (this.activeSession !== previous) expandedHistory = true;
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      } finally {
        this.loadingOlderMessages = false;
      }
    },
  },
});
