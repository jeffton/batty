import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createWebSearchToolDefinition } from "../../src/shared/web-search-tool";

const MISSING_BRAVE_SEARCH_API_KEY_MESSAGE =
  "Missing Brave Search API key. Set BRAVE_SEARCH_API_KEY in your environment before starting pi.";

export default function (pi: ExtensionAPI) {
  pi.registerTool(
    createWebSearchToolDefinition({
      getApiKey: () => process.env.BRAVE_SEARCH_API_KEY?.trim() ?? "",
      missingApiKeyMessage: MISSING_BRAVE_SEARCH_API_KEY_MESSAGE,
    }),
  );
}
