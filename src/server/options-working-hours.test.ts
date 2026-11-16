import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vite-plus/test";
import { loadAppOptions, optionsFilePath, setPushTitle } from "./options";
import { loadConfig } from "./config";

it("loads the global schedule into config and preserves it across unrelated settings writes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-working-hours-"));
  try {
    const original = await loadAppOptions(directory);
    const workingHours = {
      timeZone: "Europe/Stockholm",
      days: [1, 2, 3, 4, 5],
      start: "08:00",
      end: "16:00",
    };
    await fs.writeFile(
      optionsFilePath(directory),
      JSON.stringify({
        ...original,
        workspacesRoots: ["/projects"],
        webPushSubject: "mailto:fixture@example.com",
        workingHours,
      }),
    );
    expect((await loadConfig(directory)).workingHours).toEqual(workingHours);
    await setPushTitle(directory, "Work");
    expect((await loadAppOptions(directory)).workingHours).toEqual(workingHours);
    const invalid = { ...original, workingHours: { ...workingHours, end: "08:00" } };
    await fs.writeFile(optionsFilePath(directory), JSON.stringify(invalid));
    await expect(loadAppOptions(directory)).rejects.toThrow("Invalid workingHours");
    expect(JSON.parse(await fs.readFile(optionsFilePath(directory), "utf8"))).toEqual(invalid);
    await fs.writeFile(optionsFilePath(directory), JSON.stringify(original));
    expect((await loadAppOptions(directory)).workingHours).toBeUndefined();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
