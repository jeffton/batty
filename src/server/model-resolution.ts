import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PiModel } from "./pi-service-types";

export type ModelLookup = Pick<ModelRuntime, "getModel">;

export function resolveModel(modelRuntime: ModelLookup, modelId: string): PiModel {
  const [provider, ...rest] = modelId.split("/");
  if (!provider || rest.length === 0 || rest.some((part) => part.length === 0)) {
    throw new Error(`Invalid model id: ${modelId}`);
  }

  const resolved = modelRuntime.getModel(provider, rest.join("/"));
  if (!resolved) {
    throw new Error(`Model not found: ${modelId}`);
  }

  return resolved;
}
