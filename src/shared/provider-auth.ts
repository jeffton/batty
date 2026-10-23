export const SUBSCRIPTION_PROVIDERS = {
  openai: {
    name: "ChatGPT subscription",
    connectLabel: "Connect ChatGPT",
  },
  "openai-codex": {
    name: "OpenAI Codex (legacy)",
    connectLabel: "Connect Codex (legacy)",
  },
  anthropic: {
    name: "Anthropic (Claude Pro/Max)",
    connectLabel: "Connect Claude",
  },
} as const;

export type SubscriptionProviderId = keyof typeof SUBSCRIPTION_PROVIDERS;

export function isSubscriptionProvider(providerId: string): providerId is SubscriptionProviderId {
  return Object.hasOwn(SUBSCRIPTION_PROVIDERS, providerId);
}
