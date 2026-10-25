// @vitest-environment node
import fs from "node:fs/promises";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { createSiteIsolationRuntime, runSiteUnit } from "./site-isolation";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function runtime(source: string) {
  const root = await createSiteIsolationRuntime(source);
  roots.push(root);
  return root;
}
const noRequest = async () => null;

test("simulated VM escape: arbitrary Node is nonroot, has no host data/secrets/network and a read-only runtime plus bounded tmpfs", async () => {
  vi.stubEnv("BATTY_SITE_SECRET_ESCAPE_TEST", "must-not-inherit");
  const root = await runtime(`
    import fs from 'node:fs';
    import net from 'node:net';
    const result = { uid: process.getuid(), environment: process.env, hostFiles: {} };
    for (const file of ['/root/.ssh/id_rsa','/etc/passwd','/var/lib/batty2','/srv','/mnt','/opt/batty2','/proc/1/root/root']) {
      try { fs.statSync(file); result.hostFiles[file] = true; } catch { result.hostFiles[file] = false; }
    }
    try { fs.writeFileSync('/runtime/probe','bad'); result.runtimeWritable = true; } catch { result.runtimeWritable = false; }
    try { fs.writeFileSync('/tmp/probe','bad'); result.hostTmpWritable = true; } catch { result.hostTmpWritable = false; }
    try { fs.writeFileSync('/work/oversized', Buffer.alloc(9 * 1024 * 1024)); result.tmpUnbounded = true; } catch (error) { result.tmpError = error.code; }
    result.network = await new Promise(resolve => {
      const socket = net.connect(3148,'127.0.0.1');
      socket.on('connect', () => { socket.destroy(); resolve(true); });
      socket.on('error', () => resolve(false));
    });
    process.stdout.write(JSON.stringify({type:'done',value:result})+'\\n');
  `);
  const value = (await runSiteUnit(root, null, noRequest, AbortSignal.timeout(15000))) as Record<
    string,
    unknown
  >;
  expect(value.uid).not.toBe(0);
  expect(value.environment).toEqual({ PATH: "/usr/bin", LANG: "C.UTF-8", TMPDIR: "/work" });
  expect(Object.values(value.hostFiles as object)).toEqual(Array(7).fill(false));
  expect(value.runtimeWritable).toBe(false);
  expect(value.hostTmpWritable).toBe(false);
  expect(value.tmpError).toBe("ENOSPC");
  expect(value.network).toBe(false);
});

test("unit exit kills descendants before returning, even after arbitrary Node execution", async () => {
  const root = await runtime(`
    import {spawn} from 'node:child_process';
    const child = spawn('/usr/bin/node',['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    process.stdout.write(JSON.stringify({type:'done',value:child.pid})+'\\n');
    process.exit(0);
  `);
  const pid = (await runSiteUnit(root, null, noRequest, AbortSignal.timeout(15000))) as number;
  expect(() => process.kill(pid, 0)).toThrow();
});

test("worker IPC rejects injected transport fields, duplicate ids, extra terminals and oversized unterminated output", async () => {
  for (const source of [
    `process.stdout.write(JSON.stringify({type:'request',id:1,args:{connection:'api',url:'https://evil.example/'}})+'\\n'); setInterval(()=>{},1000);`,
    `const message=JSON.stringify({type:'request',id:1,args:{connection:'api'}})+'\\n';process.stdout.write(message+message);setInterval(()=>{},1000);`,
    `process.stdout.write(JSON.stringify({type:'done',value:1})+'\\n'+JSON.stringify({type:'done',value:2})+'\\n');setInterval(()=>{},1000);`,
    `process.stdout.write('x'.repeat(5*1024*1024));setInterval(()=>{},1000);`,
  ]) {
    const root = await runtime(source);
    const request = vi.fn(noRequest);
    await expect(runSiteUnit(root, null, request, AbortSignal.timeout(15000))).rejects.toThrow(
      /protocol|output limit/,
    );
    expect(request.mock.calls.length).toBeLessThanOrEqual(1);
  }
});

test("immediate cancellation waits for transient unit registration and leaves no running unit", async () => {
  const root = await runtime("setInterval(()=>{},1000);");
  for (let index = 0; index < 20; index++) {
    const started = Date.now();
    await expect(runSiteUnit(root, null, noRequest, AbortSignal.timeout(1))).rejects.toThrow(
      /cancelled/,
    );
    expect(Date.now() - started).toBeLessThan(1500);
  }
}, 30000);

test("cancellation stops the actual unit cgroup promptly, not just systemd-run", async () => {
  const root = await runtime(`process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
  const started = Date.now();
  await expect(runSiteUnit(root, null, noRequest, AbortSignal.timeout(300))).rejects.toThrow(
    "cancelled",
  );
  expect(Date.now() - started).toBeLessThan(5000);
});
