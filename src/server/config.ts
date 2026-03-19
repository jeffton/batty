import path from "node:path";
import { ensureOptionsFile, stateDirPath } from "./options";

export interface AppConfig {
  host: string;
  port: number;
  workspacesRoot: string;
  selfPath: string;
  battyDir: string;
  uploadsDir: string;
  publicDir: string;
  webPushDir: string;
  webPushSubject: string;
  cookieName: string;
  authSecret: string;
}

export function resolveBattyDir(argv = process.argv.slice(2)): string {
  const battyDir = argv[0]?.trim();
  if (!battyDir) {
    throw new Error("Missing batty directory argument. Pass the deployment root path as argv[2].");
  }

  return path.resolve(battyDir);
}

export async function loadConfig(battyDir: string): Promise<AppConfig> {
  const selfPath = process.cwd();
  const stateDir = stateDirPath(battyDir);
  const options = await ensureOptionsFile(battyDir);

  return {
    host: process.env.BATTY_HOST ?? "127.0.0.1",
    port: Number(process.env.BATTY_PORT ?? "3147"),
    workspacesRoot: options.workspacesRoot,
    selfPath,
    battyDir,
    uploadsDir: path.join(stateDir, "uploads"),
    publicDir: path.join(selfPath, "dist", "client"),
    webPushDir: path.join(stateDir, "web-push"),
    webPushSubject: options.webPushSubject,
    cookieName: "batty-auth",
    authSecret: options.authSecret,
  };
}
