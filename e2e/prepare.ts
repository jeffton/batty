import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const battyDir = repoRoot;
const stateDir = path.join(battyDir, ".batty");
const optionsPath = path.join(stateDir, "options.json");
const workspacesRoot = path.join(stateDir, "e2e-workspaces");
const workspacePath = path.join(workspacesRoot, "batty");

await fs.mkdir(stateDir, { recursive: true });
await fs.rm(workspacesRoot, { recursive: true, force: true });
await fs.mkdir(workspacePath, { recursive: true });
await fs.writeFile(
  optionsPath,
  `${JSON.stringify(
    {
      authSecret: crypto.randomBytes(32).toString("base64url"),
      workspacesRoot,
      webPushSubject: "https://batty.test",
    },
    null,
    2,
  )}\n`,
  "utf8",
);
