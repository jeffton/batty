import path from "node:path";
import { ensureOptionsFile, stateDirPath } from "./options";

export interface AppConfig {
  host: string;
  port: number;
  workspacesRoot: string;
  selfPath: string;
  uploadsDir: string;
  publicDir: string;
  webPushDir: string;
  webPushSubject: string;
  cookieName: string;
  username: string;
  password: string;
  authSecret: string;
}

export async function loadConfig(): Promise<AppConfig> {
  const selfPath = process.cwd();
  const stateDir = stateDirPath(selfPath);
  const options = await ensureOptionsFile(selfPath);

  return {
    host: process.env.PI_FACE_HOST ?? "127.0.0.1",
    port: Number(process.env.PI_FACE_PORT ?? "3147"),
    workspacesRoot: options.workspacesRoot,
    selfPath,
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
