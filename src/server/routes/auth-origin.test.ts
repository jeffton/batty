import fastify from "fastify";
import { describe, expect, it } from "vite-plus/test";
import { requestOrigin, requestRpId } from "./auth";

describe("authentication request origin", () => {
  it("uses the origin forwarded by a trusted HTTPS proxy", async () => {
    const app = fastify({ trustProxy: ["127.0.0.1", "::1"] });
    app.get("/", (request) => ({
      origin: requestOrigin(request),
      rpId: requestRpId(request),
    }));

    const response = await app.inject({
      method: "GET",
      url: "/",
      remoteAddress: "127.0.0.1",
      headers: {
        host: "127.0.0.1:3147",
        "x-forwarded-host": "batty.example.test",
        "x-forwarded-proto": "https",
      },
    });

    expect(response.json()).toEqual({
      origin: "https://batty.example.test",
      rpId: "batty.example.test",
    });

    await app.close();
  });
});
