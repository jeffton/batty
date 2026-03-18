import path from "node:path";
import { ensureOptionsFile, stateDirPath } from "./options";

export interface AppConfig {
  host: string;
  port: number;
  workspacesRoot: string;
  selfPath: string;
  piFaceDir: string;
  uploadsDir: string;
  publicDir: string;
  webPushDir: string;
  webPushSubject: string;
  cookieName: string;
  username: string;
  password: string;
  authSecret: string;
}

export function resolvePiFaceDir(argv = process.argv.slice(2)): string {
  const piFaceDir = argv[0]?.trim();
  if (!piFaceDir) {
    throw new Error(
      "Missing pi-face directory argument. Pass the deployment root path as argv[2].",
    );
  }

  return path.resolve(piFaceDir);
}

export async function loadConfig(piFaceDir: string): Promise<AppConfig> {
  const selfPath = process.cwd();
  const stateDir = stateDirPath(piFaceDir);
  const options = await ensureOptionsFile(piFaceDir);

  return {
    host: process.env.PI_FACE_HOST ?? "127.0.0.1",
    port: Number(process.env.PI_FACE_PORT ?? "3147"),
    workspacesRoot: options.workspacesRoot,
    selfPath,
    piFaceDir,
    uploadsDir: path.join(stateDir, "uploads"),
    publicDir: path.join(selfPath, "dist", "client"),
    webPushDir: path.join(stateDir, "web-push"),
    webPushSubject: options.webPushSubject,
    cookieName: "pi-face-auth",
    username: options.username,
    password: options.password,
    authSecret: options.authSecret,
  };
}
