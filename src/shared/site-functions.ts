export interface SiteConnection {
  /** Fixed HTTPS endpoint. Function code cannot change the destination. */
  url: string;
  headers?: Record<string, string>;
  /** Header name -> environment variable name; values never enter the sandbox. */
  secretHeaders?: Record<string, { env: string; prefix?: string }>;
}

export interface SiteFunction {
  code: string;
}

export const SITE_CALL_CHANNEL = "batty.site.call";
export const SITE_RESULT_CHANNEL = "batty.site.result";

/** Loaded by a sandboxed site; authentication stays in its Batty parent. */
export const SITE_CLIENT_SCRIPT = `(() => {
  let nextId = 0;
  const documentId = Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16).padStart(8, '0')).join('');
  const pending = new Map();
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== '${SITE_RESULT_CHANNEL}' || event.data.documentId !== documentId) return;
    const call = pending.get(event.data.id);
    if (!call) return;
    pending.delete(event.data.id);
    clearTimeout(call.timer);
    if (event.data.error) call.reject(new Error(event.data.error));
    else call.resolve(event.data.value);
  });
  window.batty = Object.freeze({ call(name, input = null) {
    if (parent === window) return Promise.reject(new Error('Open this site inside Batty to use backend functions.'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Site function timed out.')); }, 65000);
      pending.set(id, { resolve, reject, timer });
      parent.postMessage({ channel: '${SITE_CALL_CHANNEL}', documentId, id, name, input }, '*');
    });
  }});
})();`;
