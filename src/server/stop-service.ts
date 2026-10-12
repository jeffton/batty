import { loadConfig, resolveBattyDir } from "./config";
import { createAuthToken } from "./auth";

const config = await loadConfig(resolveBattyDir());
if (!["127.0.0.1", "::1", "localhost"].includes(config.host))
  throw new Error("Service stop requires a loopback listener");
const host = config.host === "::1" ? "[::1]" : config.host;
const response = await fetch(`http://${host}:${config.port}/api/service/stop`, {
  method: "POST",
  headers: { cookie: `${config.cookieName}=${createAuthToken(config.authSecret, 60_000)}` },
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`Service stop failed: HTTP ${response.status}`);
