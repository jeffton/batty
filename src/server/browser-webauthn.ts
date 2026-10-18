import type { BrowserContext } from "patchright";

// Runs in the page's main world, including when reconnecting existing documents.
// This is a browser capability policy, not a tamper-proof security boundary.
export function disableWebAuthn(): void {
  Reflect.deleteProperty(globalThis, "PublicKeyCredential");
  const prototype = globalThis.CredentialsContainer?.prototype;
  if (!prototype) return;
  const installed = Symbol.for("batty.webauthnDisabled");
  if (Reflect.get(prototype, installed)) return;
  for (const method of ["get", "create"] as const) {
    const original = prototype[method];
    Object.defineProperty(prototype, method, {
      configurable: true,
      writable: true,
      value: function (this: CredentialsContainer, options?: object) {
        if (options && "publicKey" in options) {
          return Promise.reject(
            new DOMException("Passkeys are unavailable in this browser.", "NotAllowedError"),
          );
        }
        return Reflect.apply(original, this, arguments);
      },
    });
  }
  Object.defineProperty(prototype, installed, { value: true });
}

export async function installWebAuthnPolicy(context: BrowserContext): Promise<void> {
  // All tool browsers can acquire a cloud viewer later. Install before navigation,
  // rather than changing capabilities when a viewer attaches.
  await context.addInitScript(disableWebAuthn);
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      // Patchright evaluates in an isolated world by default. Websites must see
      // this policy in their main world; no reload or loss of page state is needed.
      try {
        await frame.evaluate(disableWebAuthn, undefined, undefined, false);
      } catch (error) {
        // The init script covers the replacement document. A disappearing frame
        // must not turn a service reconnect into closure of all browser tabs.
        if (frame.isDetached() || page.isClosed()) continue;
        if (error instanceof Error && error.message.includes("Execution context was destroyed"))
          continue;
        throw error;
      }
    }
  }
}
