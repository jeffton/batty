import { expect, test } from "vite-plus/test";
import { isNodeRoute } from "./reverse-transport";

test("reverse routing only bridges the existing agent API", () => {
  for (const route of [
    "identity",
    "workspaces",
    "catalog/events",
    "assignments/123",
    "sessions/42/events?after=8",
    "files/work/12/tool/file",
  ])
    expect(isNodeRoute(route, "GET"), route).toBe(true);
  expect(isNodeRoute("commands", "POST")).toBe(true);
  expect(isNodeRoute("unpair", "POST")).toBe(true);
  for (const route of [
    "https://other.test/api/node/identity",
    "/api/main",
    "../main",
    "reverse/control",
    "workspaces?url=http://elsewhere",
    "sessions/42/events?after=0&url=x",
    "files/work/12/tool/..",
    "files/work/12/tool/%2fsecret",
    "files/work/12/tool/%5csecret",
    "files/work/12/tool/%00",
    "files/work/12/tool/%",
  ])
    expect(isNodeRoute(route, "GET"), route).toBe(false);
  expect(isNodeRoute("identity", "POST")).toBe(false);
  expect(isNodeRoute("commands", "DELETE")).toBe(false);
});
