import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  generateUnifiedPatch,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { DurableFileChange } from "./agent-turn-file-changes";
import type { SentFileDescriptor, SiteDescriptor } from "@/shared/types";

interface Artifacts {
  battyFileChanges?: DurableFileChange[];
  sentFiles?: SentFileDescriptor[];
  sites?: SiteDescriptor[];
}

/** Injectable SDK filesystem operations keep mutations on immutable tool results. */
export function createTrackedFileTools(cwd: string): ToolDefinition<any, any, any>[] {
  const changes = new AsyncLocalStorage<DurableFileChange[]>();
  const writeFile = async (file: string, content: string) => {
    let before: string | null;
    try {
      before = await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      before = null;
    }
    await fs.writeFile(file, content);
    if (before === content) return;
    const canonical = await fs.realpath(file);
    changes.getStore()!.push({
      path: canonical,
      before,
      after: content,
      patch: generateUnifiedPatch(canonical, before ?? "", content),
    });
  };
  const definitions = [
    createWriteToolDefinition(cwd, {
      operations: {
        writeFile,
        mkdir: async (directory) => {
          await fs.mkdir(directory, { recursive: true });
        },
      },
    }),
    createEditToolDefinition(cwd, {
      operations: {
        writeFile,
        readFile: (file) => fs.readFile(file),
        access: (file) => fs.access(file, constants.R_OK | constants.W_OK),
      },
    }),
  ];
  return definitions.map((definition) => {
    const tool = definition as unknown as ToolDefinition<any, any, any>;
    return {
      ...tool,
      async execute(...args: Parameters<typeof tool.execute>) {
        const snapshots: DurableFileChange[] = [];
        try {
          const result = await changes.run(snapshots, () => tool.execute(...args));
          return { ...result, details: { ...result.details, battyFileChanges: snapshots } };
        } catch (error) {
          if (!snapshots.length) throw error;
          // Native write/edit check cancellation after writing. The mutation still
          // belongs to this error result even when the SDK execution throws.
          return {
            content: [
              {
                type: "text" as const,
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            details: { battyFileChanges: snapshots },
            isError: true,
          };
        }
      },
    };
  });
}

/** Nested results stay out of model context; their user-facing artifacts belong to the outer result. */
export function createArtifactExtension(): ExtensionFactory {
  return (pi) => {
    const roots = new Map<string, string>();
    const collected = new Map<string, Required<Artifacts>>();
    pi.on("agent_end", () => {
      roots.clear();
      collected.clear();
    });
    pi.on("tool_call", (event) => {
      roots.set(
        event.toolCallId,
        event.parentToolCallId
          ? (roots.get(event.parentToolCallId) ?? event.parentToolCallId)
          : event.toolCallId,
      );
      return undefined;
    });
    pi.on("tool_result", (event) => {
      const root = roots.get(event.toolCallId)!;
      roots.delete(event.toolCallId);
      if (event.parentToolCallId) {
        const artifacts = event.details as Artifacts | undefined;
        const aggregate = collected.get(root) ?? { battyFileChanges: [], sentFiles: [], sites: [] };
        aggregate.battyFileChanges.push(...(artifacts?.battyFileChanges ?? []));
        aggregate.sentFiles.push(...(artifacts?.sentFiles ?? []));
        aggregate.sites.push(...(artifacts?.sites ?? []));
        collected.set(root, aggregate);
        return undefined;
      }
      const artifacts = collected.get(root);
      collected.delete(root);
      if (!artifacts) return undefined;
      const own = event.details as Artifacts | undefined;
      return {
        details: {
          ...(event.details as Record<string, unknown>),
          battyFileChanges: [...(own?.battyFileChanges ?? []), ...artifacts.battyFileChanges],
          sentFiles: [...(own?.sentFiles ?? []), ...artifacts.sentFiles],
          sites: [...(own?.sites ?? []), ...artifacts.sites],
        },
      };
    });
  };
}
