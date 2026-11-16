import { EventEmitter } from "node:events";
import { createECDH, randomBytes } from "node:crypto";
import https from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import * as webpush from "web-push";
import { afterEach, expect, it, vi } from "vite-plus/test";

afterEach(() => vi.restoreAllMocks());

it("generates VAPID credentials and encrypts a notification with the installed ESM package", () => {
  const keys = webpush.generateVAPIDKeys();
  const receiver = createECDH("prime256v1");
  receiver.generateKeys();
  const request = webpush.generateRequestDetails(
    {
      endpoint: "https://fcm.googleapis.com/fcm/send/test",
      keys: {
        p256dh: receiver.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    },
    JSON.stringify({ title: "Completion", body: "Done" }),
    {
      vapidDetails: { subject: "mailto:test@example.com", ...keys },
      TTL: 60,
    },
  );
  expect(request.method).toBe("POST");
  expect(request.headers["Content-Encoding"]).toBe("aes128gcm");
  expect(request.headers.Authorization).toMatch(/^vapid t=/);
  expect(request.body?.length).toBeGreaterThan(100);
});

it.each([301, 302, 303, 307, 308])(
  "web-push rejects %s redirects without requesting an internal Location",
  async (statusCode) => {
    // Exercise the real installed transport, not the service's mocked sender.
    const request = vi.spyOn(https, "request").mockImplementation((...args) => {
      const callback = args.find((arg) => typeof arg === "function") as
        | ((response: IncomingMessage) => void)
        | undefined;
      const response = new EventEmitter() as IncomingMessage;
      response.statusCode = statusCode;
      response.headers = { location: "https://127.0.0.1/internal" };
      const outgoing = new EventEmitter() as ClientRequest;
      outgoing.end = (() => {
        callback!(response);
        response.emit("end");
        return outgoing;
      }) as ClientRequest["end"];
      return outgoing;
    });

    await expect(
      webpush.sendNotification(
        { endpoint: "https://fcm.googleapis.com/fcm/send/token", keys: { p256dh: "", auth: "" } },
        undefined,
        { vapidDetails: undefined },
      ),
    ).rejects.toMatchObject({ statusCode });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      hostname: "fcm.googleapis.com",
      method: "POST",
    });
  },
);
