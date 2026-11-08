import { webkit } from "playwright-core";

// The explicit container runner supplies this endpoint; connection errors propagate.
export function launchWebKit() {
  const endpoint = process.env.BATTY_TEST_WEBKIT_WS_ENDPOINT;
  return endpoint
    ? webkit.connect(endpoint, { exposeNetwork: "<loopback>" })
    : webkit.launch({ headless: true });
}
