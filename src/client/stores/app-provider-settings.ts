import {
  completeOpenAICodexProviderAuth,
  getBattyAgentsFile,
  getModels,
  getProviderAuthStatus,
  setAppearance as setAppearanceRequest,
  setBattyAgentsFile as setBattyAgentsFileRequest,
  setBraveSearchApiKey as setBraveSearchApiKeyRequest,
  setDefaultModel as setDefaultModelRequest,
  setProviderApiKey,
  startOpenAICodexProviderAuth,
} from "@/client/lib/api";
import { applyAppAppearance } from "@/client/lib/appearance";
import type { AppAppearance } from "@/shared/appearance";
import type { AppActionContext } from "./app-state";

export const providerSettingsActions = {
  async refreshModels(this: AppActionContext): Promise<void> {
    this.models = await getModels();
  },

  async refreshProviderAuthStatus(this: AppActionContext): Promise<void> {
    this.providerAuth = await getProviderAuthStatus();
  },

  async startOpenAICodexProviderAuth() {
    return startOpenAICodexProviderAuth();
  },

  async completeOpenAICodexProviderAuth(
    this: AppActionContext,
    attemptId: string,
    callbackUrlOrCode: string,
  ): Promise<void> {
    this.providerAuth = await completeOpenAICodexProviderAuth(attemptId, callbackUrlOrCode);
    await this.bootstrap();
  },

  async setProviderApiKey(
    this: AppActionContext,
    providerId: "google" | "openrouter",
    apiKey: string,
  ): Promise<void> {
    this.providerAuth = await setProviderApiKey(providerId, apiKey);
    await this.bootstrap();
  },

  async setDefaultModel(this: AppActionContext, modelId: string): Promise<void> {
    this.settings = await setDefaultModelRequest(modelId);
  },

  async setAppearance(this: AppActionContext, appearance: AppAppearance): Promise<void> {
    this.settings = await setAppearanceRequest(appearance);
    applyAppAppearance(this.settings.appearance);
    navigator.serviceWorker?.controller?.postMessage({ type: "refresh-app-shell" });
  },

  async setBraveSearchApiKey(this: AppActionContext, apiKey: string): Promise<void> {
    this.settings = await setBraveSearchApiKeyRequest(apiKey);
  },

  async getBattyAgentsFile(): Promise<string> {
    return (await getBattyAgentsFile()).content;
  },

  async setBattyAgentsFile(content: string): Promise<string> {
    return (await setBattyAgentsFileRequest(content)).content;
  },
};
