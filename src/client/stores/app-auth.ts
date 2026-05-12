import { getBootstrap, getVersion, logout as logoutRequest } from "@/client/lib/api";
import { readCachedBootstrap, writeCachedBootstrap } from "@/client/lib/cache";
import { syncPushSubscription } from "@/client/lib/push-notifications";
import { sortWorkspacesByRecentSession, uniqueWorkspaces } from "@/client/lib/workspaces";
import type { BootstrapPayload } from "@/shared/types";
import {
  defaultAppSettingsStatus,
  defaultProviderAuthStatus,
  type AppActionContext,
} from "./app-state";

export const authBootstrapActions = {
  async bootstrap(this: AppActionContext): Promise<void> {
    this.connectionState = navigator.onLine ? "online" : "offline";
    try {
      const payload = await getBootstrap();
      this.applyBootstrap(payload);
      await writeCachedBootstrap(payload);
      if (payload.authenticated) {
        void syncPushSubscription(false);
      }
    } catch (error) {
      const cached = await readCachedBootstrap();
      if (cached) {
        this.connectionState = "offline";
        this.applyBootstrap(cached);
        this.closeWorkspaceStream();
        this.lastError = error instanceof Error ? error.message : String(error);
      } else {
        throw error;
      }
    } finally {
      this.bootstrapped = true;
    }
  },

  applyBootstrap(this: AppActionContext, payload: BootstrapPayload): void {
    const workspaces = uniqueWorkspaces(payload.workspaces);

    this.authenticated = payload.authenticated;
    this.auth = payload.auth;
    this.buildId = payload.buildId;
    this.providerAuth = payload.providerAuth ?? defaultProviderAuthStatus;
    this.settings = payload.settings ?? defaultAppSettingsStatus;
    this.workspaceRoots = payload.workspaceRoots ?? [];
    this.workspaces = sortWorkspacesByRecentSession(workspaces);
    this.workspaceUiSettings = payload.workspaceUiSettings ?? {};
    this.models = payload.models;
    this.selectedWorkspaceId =
      this.selectedWorkspaceId &&
      this.workspaces.some((workspace) => workspace.id === this.selectedWorkspaceId)
        ? this.selectedWorkspaceId
        : this.workspaces[0]?.id;
    if (payload.authenticated) {
      this.authError = undefined;
      if (this.selectedWorkspaceId && this.connectionState !== "offline") {
        this.openWorkspaceStream(this.selectedWorkspaceId);
      }
    } else {
      this.activeSession = undefined;
      this.providerAuth = defaultProviderAuthStatus;
      this.settings = defaultAppSettingsStatus;
      this.sessionsByWorkspace = {};
      this.cronJobsByWorkspace = {};
      this.runningCronJobsByWorkspace = {};
      this.workspaceUiSettings = {};
      this.closeStream();
      this.closeWorkspaceStream();
    }
  },

  setAuthError(this: AppActionContext, error: unknown): void {
    this.authError = error instanceof Error ? error.message : String(error);
  },

  async logout(this: AppActionContext): Promise<void> {
    await logoutRequest();
    this.closeStream();
    this.closeWorkspaceStream();
    this.authenticated = false;
    this.providerAuth = defaultProviderAuthStatus;
    this.settings = defaultAppSettingsStatus;
    this.activeSession = undefined;
    this.sessionsByWorkspace = {};
    this.cronJobsByWorkspace = {};
    this.runningCronJobsByWorkspace = {};
    this.workspaceUiSettings = {};
  },

  async checkForClientUpdate(this: AppActionContext): Promise<void> {
    if (!this.bootstrapped) {
      return;
    }

    const currentBuildId = this.buildId;
    const { buildId } = await getVersion();
    this.buildId = buildId;
    if (currentBuildId && currentBuildId !== buildId) {
      window.location.reload();
    }
  },

  markOffline(this: AppActionContext): void {
    this.connectionState = "offline";
  },

  markOnline(this: AppActionContext): void {
    this.connectionState = "online";
    if (this.selectedWorkspaceId) {
      this.openWorkspaceStream(this.selectedWorkspaceId);
    }
    if (this.activeSession) {
      this.openStream(this.activeSession);
    }
  },
};
