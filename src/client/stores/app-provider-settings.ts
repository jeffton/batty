import {
  completeOpenAICodexProviderAuth,
  getBattyAgentsFile,
  getModels,
  getProviderAuthStatus,
  setBattyAgentsFile as setBattyAgentsFileRequest,
  setBraveSearchApiKey as setBraveSearchApiKeyRequest,
  setProviderApiKey,
  startOpenAICodexProviderAuth,
} from "@/client/lib/api";
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
