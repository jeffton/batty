import { SITE_CALL_CHANNEL, SITE_RESULT_CHANNEL } from "@/shared/site-functions";
import { withBaseUrl } from "./base-url";

export async function callSiteFunction(
  siteId: string,
  name: string,
  input: unknown,
): Promise<unknown> {
  const response = await fetch(
    withBaseUrl(`/api/sites/${encodeURIComponent(siteId)}/functions/${encodeURIComponent(name)}`),
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Site function failed");
  return result.value;
}

/** Never trust a siteId/origin supplied by an opaque-origin site. Bind its actual frame. */
export function createSiteMessageHandler(
  frames: () => Iterable<HTMLIFrameElement>,
  call = callSiteFunction,
): (event: MessageEvent) => Promise<void> {
  let pending = 0;
  return async (event) => {
    const frame = Array.from(frames()).find(
      (candidate) => candidate.contentWindow === event.source,
    );
    const data = event.data;
    if (
      !frame ||
      data?.channel !== SITE_CALL_CHANNEL ||
      !Number.isSafeInteger(data.id) ||
      typeof data.documentId !== "string" ||
      !/^[0-9a-f]{32}$/.test(data.documentId) ||
      typeof data.name !== "string"
    )
      return;
    const source = frame.contentWindow!;
    const respond = (result: object) =>
      source.postMessage(
        { channel: SITE_RESULT_CHANNEL, documentId: data.documentId, id: data.id, ...result },
        "*",
      );
    if (pending >= 4) {
      respond({ error: "Site functions are busy. Try again shortly." });
      return;
    }
    pending++;
    try {
      const value = await call(frame.dataset.siteId!, data.name, data.input);
      if (frame.isConnected) respond({ value });
    } catch (error) {
      if (frame.isConnected)
        respond({ error: error instanceof Error ? error.message : "Site function failed" });
    } finally {
      pending--;
    }
  };
}
