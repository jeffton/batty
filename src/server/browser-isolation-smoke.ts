import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { BrowserService } from "./browser-service";
import { browserSessionDirectory, readBrowserJson } from "./browser-persistence";
import { SshSocksProxy } from "./ssh-socks-proxy";
import { startNativeBrowserVideo } from "./native-browser-video";

export async function verifyBrowserIsolation(): Promise<void> {
  // Isolated synthetic data only; no service state, credentials or account interaction.
  assert.equal(process.platform, "linux");
  assert.equal(process.getuid?.(), 0);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-isolation-smoke-"));
  const website = http.createServer((req, res) => {
    if (req.url === "/download") {
      res.setHeader("Content-Disposition", 'attachment; filename="fixture.txt"');
      res.end("sandbox download");
    } else {
      res.end(
        '<html><body><h1>Sandbox fixture</h1><input type="file"><a href="/download">Download</a></body></html>',
      );
    }
  });
  website.listen(0, "127.0.0.1");
  await once(website, "listening");
  const url = `http://127.0.0.1:${(website.address() as { port: number }).port}/`;
  const proxy = process.env.BATTY_BROWSER_SSH_DESTINATION
    ? new SshSocksProxy(process.env.BATTY_BROWSER_SSH_DESTINATION)
    : undefined;
  const service = new BrowserService(proxy, 4, root);
  let video: ReturnType<typeof startNativeBrowserVideo> | undefined;
  try {
    const opened = await service.execute("smoke", { action: "open", url, cloud: true });
    const id = opened.details.sites![0]!.browserId;
    const directory = browserSessionDirectory(root, "smoke");
    const receipt = (await readBrowserJson<{ pid: number }>(path.join(directory, "browser.json")))!;
    const isolation = (await readBrowserJson<{ uid: number; gid: number; directory: string }>(
      path.join(directory, "isolation.json"),
    ))!;
    const status = await fs.readFile(`/proc/${receipt.pid}/status`, "utf8");
    assert.match(status, new RegExp(`Uid:\\s+${isolation.uid}\\s+${isolation.uid}`));
    assert.match(status, /Groups:\s*\n/);
    assert.match(status, /CapEff:\s+0+\n/);
    assert.match(status, /NoNewPrivs:\s+1\n/);
    const command = await fs.readFile(`/proc/${receipt.pid}/cmdline`, "utf8");
    assert(!command.includes("--no-sandbox"));
    if (process.env.BATTY_BROWSER_EXECUTABLE_PATH)
      assert.equal(
        await fs.readlink(`/proc/${receipt.pid}/exe`),
        process.env.BATTY_BROWSER_EXECUTABLE_PATH,
      );
    const { page } = await service.cloudTarget(id);
    await page.goto("chrome://sandbox");
    const sandbox = await page.locator("body").innerText();
    assert.match(sandbox, /PID namespaces\s+Yes/);
    assert.match(sandbox, /Network namespaces\s+Yes/);
    assert.match(sandbox, /Seccomp-BPF sandbox\s+Yes/);
    assert.match(sandbox, /adequately sandboxed/);
    await page.goto(url);
    const upload = path.join(root, "private-upload.txt");
    await fs.writeFile(upload, "sandbox upload", { mode: 0o600 });
    await service.execute("smoke", { action: "upload", selector: "input", paths: [upload] });
    assert.equal(
      await page
        .locator("input")
        .evaluate(async (input) => await (input as HTMLInputElement).files![0]!.text()),
      "sandbox upload",
    );
    const downloaded = await service.execute("smoke", { action: "download", selector: "a" });
    assert.equal(await fs.readFile(downloaded.downloadPaths![0]!, "utf8"), "sandbox download");
    const state = await service.cloudState(id);
    const geometry = await service.cloudVideoGeometry(id, state);
    const display = (await readBrowserJson<{ pid: number }>(path.join(directory, "display.json")))!;
    assert.equal((await fs.stat(`/proc/${display.pid}`)).uid, isolation.uid);
    let frames = 0;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("No H.264 frames within 10 seconds")),
        10_000,
      );
      video = startNativeBrowserVideo(
        geometry,
        state,
        1,
        () => {
          if (++frames >= 5) {
            clearTimeout(timer);
            resolve();
          }
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
    await video!.stop();
    video = undefined;
    if (proxy) {
      const proxied = await service.execute("proxy", {
        action: "open",
        url: "https://example.com/",
        cloud: true,
        useTailscale: true,
        timeoutMs: 30_000,
      });
      assert.equal(new URL(proxied.details.url!).hostname, "example.com");
      const proxyPage = (await service.cloudTarget(proxied.details.sites![0]!.browserId)).page;
      const response = await proxyPage.goto("https://example.com/", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      assert.equal(response?.status(), 200);

      const target = await service.execute("proxy", {
        action: "evaluate",
        script: "document.title",
      });
      assert.match(target.text, /Example Domain/);
    }
    console.log(
      JSON.stringify(
        {
          browserVersion: page.context().browser()!.version(),
          executable: await fs.readlink(`/proc/${receipt.pid}/exe`),
          uid: isolation.uid,
          gid: isolation.gid,
          supplementaryGroups: [],
          effectiveCapabilities: 0,
          sandbox: sandbox.trim(),
          xvfbUid: isolation.uid,
          h264Frames: frames,
          upload: "passed",
          download: "passed",
          proxy: proxy ? "SSH SOCKS / example.com passed" : "not requested",
        },
        null,
        2,
      ),
    );
  } finally {
    await video?.stop();
    await service.closeSession("smoke");
    await service.closeSession("proxy");
    await service.dispose();
    await proxy?.dispose();
    website.closeAllConnections();
    await new Promise<void>((resolve) => website.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}
