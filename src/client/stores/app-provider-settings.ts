import {
  completeOpenAIProviderAuth,
  getBattyAgentsFile,
  getModels,
  getProviderAuthStatus,
  setAppearance as setAppearanceRequest,
  setBattyAgentsFile as setBattyAgentsFileRequest,
  setBraveSearchApiKey as setBraveSearchApiKeyRequest,
  setDefaultModel as setDefaultModelRequest,
  setProviderApiKey,
  startOpenAIProviderAuth,
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

  async startOpenAIProviderAuth() {
    return startOpenAIProviderAuth();
  },

  async completeOpenAIProviderAuth(
    this: AppActionContext,
    attemptId: string,
    callbackUrl: string,
  ): Promise<void> {
    this.providerAuth = await completeOpenAIProviderAuth(attemptId, callbackUrl);
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

  async setDefaultModel(
    this: AppActionContext,
    modelId: string,
    thinkingLevel: string,
  ): Promise<void> {
    this.settings = await setDefaultModelRequest(modelId, thinkingLevel);
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
