import fs from "node:fs/promises";
import path from "node:path";
import type { SiteConnection, SiteFunction } from "@/shared/site-functions";
import { getSite } from "./sites";
import { SITE_MAX_BYTES, requestSiteConnection } from "./site-http";
import { runIsolatedSiteFunction } from "./site-isolation";

const failure = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
function functionName(name: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) throw failure("Invalid function name");
  return name;
}
async function functionFile(root: string, siteId: string, name: string): Promise<string> {
  const site = await getSite(root, "", siteId);
  return path.join(path.dirname(site.directory), "functions", `${functionName(name)}.json`);
}
export async function registerSiteFunction(
  root: string,
  siteId: string,
  name: string,
  definition: SiteFunction,
): Promise<void> {
  const file = await functionFile(root, siteId, name);
  if (!definition.code.trim() || definition.code.length > 64 * 1024)
    throw failure("Function code must be between 1 and 65536 characters");
  if (Object.keys(definition).some((key) => key !== "code"))
    throw failure("Connections are host-admin grants, not function registrations");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(definition), { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
export async function deleteSiteFunction(
  root: string,
  siteId: string,
  name: string,
): Promise<void> {
  await fs.unlink(await functionFile(root, siteId, name));
}

/** Host-admin grant registry. Function code/registration cannot create or modify grants. */
export function siteConnectionGrant(siteId: string, connection: string): SiteConnection {
  const registry = JSON.parse(process.env.BATTY_SITE_CONNECTIONS ?? "{}") as Record<
    string,
    Record<string, SiteConnection>
  >;
  if (!Object.hasOwn(registry, siteId) || !Object.hasOwn(registry[siteId]!, connection))
    throw new Error("Connection is not granted to this site");
  return registry[siteId]![connection]!;
}

let active = 0;
export async function executeSiteFunction(
  root: string,
  siteId: string,
  name: string,
  input: unknown,
): Promise<unknown> {
  let definition: SiteFunction;
  try {
    definition = JSON.parse(await fs.readFile(await functionFile(root, siteId, name), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw failure("Site function not found", 404);
    throw error;
  }
  if (active >= 4) throw failure("Site functions are busy. Try again shortly.", 429);
  active++;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 70_000);
  try {
    const value = await runIsolatedSiteFunction(
      definition.code,
      input,
      (args) =>
        requestSiteConnection(siteConnectionGrant(siteId, args.connection), args, abort.signal),
      abort.signal,
    );
    if (Buffer.byteLength(JSON.stringify(value)) > SITE_MAX_BYTES)
      throw failure("Function result too large", 502);
    return value;
  } catch (error) {
    throw failure(error instanceof Error ? error.message : "Site function failed", 502);
  } finally {
    clearTimeout(timeout);
    abort.abort();
    active--;
  }
}
