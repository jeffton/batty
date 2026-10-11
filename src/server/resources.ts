import fs from "node:fs/promises";
import path from "node:path";
import { loadSkills, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { defineExtension, section } from "@earendil-works/pi-durable";
import type { AppConfig } from "./config";
import { stateDirPath } from "./options";
import { listWorkspaces } from "./workspaces";
import { ATTACHMENT_DELIVERY_INSTRUCTION } from "./attachment-contract";

export function createResources(config: AppConfig) {
  const agentDir = stateDirPath(config.battyDir);
  function skills(cwd: string, assistantPath?: string) {
    const skillPaths = [path.join(agentDir, "skills"), path.join(cwd, ".batty", "skills")];
    if (assistantPath) {
      skillPaths.push(
        path.join(assistantPath, ".batty", "skills"),
        path.join(assistantPath, "skills"),
      );
    }
    const result = loadSkills({
      cwd,
      agentDir,
      skillPaths: [...new Set(skillPaths.map((skillPath) => path.resolve(skillPath)))],
      includeDefaults: false,
    });
    for (const diagnostic of result.diagnostics) console.warn("Skill diagnostic", diagnostic);
    return result.skills;
  }
  async function instructions(cwd: string) {
    const files = [path.join(agentDir, "AGENTS.md"), path.join(cwd, "AGENTS.md")];
    const texts: string[] = [];
    for (const file of [...new Set(files)]) {
      try {
        texts.push(await fs.readFile(file, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return texts.join("\n\n");
  }
  return {
    skills,
    async sessionSkills(cwd: string) {
      const workspaces = await listWorkspaces(config);
      const assistantPath = workspaces.find((workspace) => workspace.isAssistant)?.path;
      return skills(cwd, assistantPath);
    },
    extension: defineExtension({
      name: "batty-resources",
      sections: [
        section("attachments", () => ATTACHMENT_DELIVERY_INSTRUCTION),
        section(
          "assistant",
          () =>
            "You are running in Batty, a runtime with one permanent main thread. In main, you own the user's continuing conversation and integrate worker reports. Runtime notices identify subagent assignments, scheduled turns, steering and results; they are harness context, not messages written by the user. Follow the role and execution scope specified in the current assignment notice. A copied conversation is reference context, not a new assignment. Delegate focused work to subagents in its target workspace.",
        ),
        section("cwd", (input) => input.agent.cwd),
        section("skills", (input) =>
          formatSkillsForPrompt(skills(input.agent.cwd ?? config.selfPath)),
        ),
        section("user-instructions", (input) => instructions(input.agent.cwd ?? config.selfPath)),
      ],
    }),
  };
}
