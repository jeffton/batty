import os from "node:os";
import path from "node:path";

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
  authPassword: string;
  authSecret: string;
}

const DEFAULT_PASSWORD = "pi-face-d3mQm4Hc-9rY2Qv7-7nLk";
const DEFAULT_SECRET = "pi-face-session-3e5db1f1-96df-4da5-8a08-0d56930a9252";

export function loadConfig(): AppConfig {
  const selfPath = process.cwd();
  const workspacesRoot = process.env.PI_FACE_WORKSPACES_DIR ?? path.join(os.homedir(), "github");

  return {
    host: process.env.PI_FACE_HOST ?? "127.0.0.1",
    port: Number(process.env.PI_FACE_PORT ?? "3147"),
    workspacesRoot,
    selfPath,
    uploadsDir: process.env.PI_FACE_UPLOADS_DIR ?? path.join(selfPath, ".data", "uploads"),
    publicDir: path.join(selfPath, "dist", "client"),
    webPushDir: process.env.PI_FACE_WEB_PUSH_DIR ?? path.join(selfPath, ".data", "web-push"),
    webPushSubject: process.env.PI_FACE_WEB_PUSH_SUBJECT ?? "mailto:pi-face@localhost",
    cookieName: "pi-face-auth",
    authPassword: process.env.PI_FACE_PASSWORD ?? DEFAULT_PASSWORD,
    authSecret: process.env.PI_FACE_SECRET ?? DEFAULT_SECRET,
  };
}
