import {
  createContextKey,
  withContextValue,
  type AgentHarnessTool,
  type Context,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import type { DurableFileChange } from "./agent-turn-file-changes";

const changesKey = createContextKey<DurableFileChange[]>("batty.file-changes");

/** One shared environment preserves Pi's canonical-path file mutation queue. */
export class TrackedExecutionEnv extends NodeExecutionEnv {
  override async writeFile(file: string, content: string | Uint8Array, context: Context) {
    const changes = context.value(changesKey);
    if (!changes || typeof content !== "string") return super.writeFile(file, content, context);
    const before = await this.readTextFile(file, context);
    if (!before.ok && before.error.code !== "not_found") return before;
    const result = await super.writeFile(file, content, context);
    if (result.ok && (!before.ok || before.value !== content)) {
      const resolved = await this.canonicalPath(file, context);
      if (!resolved.ok) return resolved;
      changes.push({
        path: resolved.value,
        before: before.ok ? before.value : null,
        after: content,
        patch: generateUnifiedPatch(resolved.value, before.ok ? before.value : "", content),
      });
    }
    return result;
  }
}

/** File diffs are immutable tool-result metadata and survive harness recovery/forks. */
export function trackFileChanges<T extends ExecutionToolContext>(
  tool: AgentHarnessTool<T, any>,
): AgentHarnessTool<T, any> {
  return {
    ...tool,
    async execute(id, args, update, toolContext, invocation, context) {
      const changes: DurableFileChange[] = [];
      const result = await tool.execute(
        id,
        args,
        update,
        toolContext,
        invocation,
        withContextValue(changesKey, changes, context),
      );
      return { ...result, details: { ...(result.details as object), battyFileChanges: changes } };
    },
  };
}
