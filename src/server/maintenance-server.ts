import path from "node:path";
import { resolveBattyDir } from "./config";
import { createMaintenanceApp } from "./maintenance-app";
import { mainLoopback } from "./maintenance-state";

const root = resolveBattyDir();
const selfPath = process.env.BATTY_SELF_PATH ?? process.cwd();
const app = await createMaintenanceApp(
  root,
  path.join(selfPath, "dist", "client"),
  mainLoopback(Number(process.env.BATTY_MAIN_PORT ?? 3148), process.env.BATTY_MAIN_HOST),
);
process.once("SIGTERM", () => void app.close());
process.once("SIGINT", () => void app.close());
await app.listen({ host: "127.0.0.1", port: Number(process.env.BATTY_MAINTENANCE_PORT ?? 3149) });
