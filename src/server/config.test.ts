import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { resolvePiFaceDir } from "@/server/config";

describe("resolvePiFaceDir", () => {
  it("requires a pi-face directory argument", () => {
    expect(() => resolvePiFaceDir([])).toThrow(
      "Missing pi-face directory argument. Pass the deployment root path as argv[2].",
    );
  });

  it("resolves the provided path", () => {
    expect(resolvePiFaceDir(["."])).toBe(path.resolve("."));
    expect(resolvePiFaceDir(["~/ignored-as-literal"])).toBe(path.resolve("~/ignored-as-literal"));
    expect(resolvePiFaceDir([os.tmpdir()])).toBe(path.resolve(os.tmpdir()));
  });
});
