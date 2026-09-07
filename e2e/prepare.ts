import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { E2E_BATTY_ROOT } from "./env";

const repoRoot = process.cwd();
const battyDir = E2E_BATTY_ROOT;
const stateDir = path.join(battyDir, ".batty");
const optionsPath = path.join(stateDir, "options.json");
const workspacesRoot = path.join(repoRoot, ".batty", "e2e-workspaces");
const workspacePath = path.join(workspacesRoot, "batty");

await fs.rm(E2E_BATTY_ROOT, { recursive: true, force: true });
await fs.mkdir(stateDir, { recursive: true });
await fs.rm(workspacesRoot, { recursive: true, force: true });
await fs.mkdir(workspacePath, { recursive: true });
await fs.writeFile(
  optionsPath,
  `${JSON.stringify(
    {
      authSecret: crypto.randomBytes(32).toString("base64url"),
      workspacesRoots: [workspacesRoot],
      webPushSubject: "https://batty.test",
      defaultProvider: "openai-codex",
      defaultModel: "gpt-6-astra",
    },
    null,
    2,
  )}\n`,
  "utf8",
);
