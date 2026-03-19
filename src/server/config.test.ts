import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { resolveBattyDir } from "@/server/config";

describe("resolveBattyDir", () => {
  it("requires a batty directory argument", () => {
    expect(() => resolveBattyDir([])).toThrow(
      "Missing batty directory argument. Pass the deployment root path as argv[2].",
    );
  });

  it("resolves the provided path", () => {
    expect(resolveBattyDir(["."])).toBe(path.resolve("."));
    expect(resolveBattyDir(["~/ignored-as-literal"])).toBe(path.resolve("~/ignored-as-literal"));
    expect(resolveBattyDir([os.tmpdir()])).toBe(path.resolve(os.tmpdir()));
  });
});
