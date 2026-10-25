# Sites and backend functions

`sites create` allocates a static content directory. Write HTML/assets there and use `sites share` to attach the site to the conversation. Private previews use a read-only capability URL; public sharing exposes static content only.

## Register a function

The `sites` tool accepts a site-scoped async JavaScript body:

```json
{
  "action": "function",
  "siteId": "<site UUID>",
  "functionName": "generate",
  "code": "const input = await tools.input(); return await tools.request({ connection: 'images', body: { prompt: input.prompt } });"
}
```

Registration atomically replaces that function. `action: "delete_function"` with `siteId` and `functionName` removes it. Definitions live outside the publicly served `content/` tree with owner-only permissions. Registrations contain code, not connection grants or secret values.

Load the client SDK in the site's HTML (include the installation's base prefix when applicable):

```html
<script src="/site-runtime.js"></script>
<script>
  async function generate(prompt) {
    try {
      const result = await batty.call("generate", { prompt });
      // Render the returned JSON.
    } catch (error) {
      // Display the error and allow another attempt.
    }
  }
</script>
```

Calls work inside the native Batty site popover. Standalone/public/capability-preview pages do not get backend access. The SDK reports that the site must be opened inside Batty. The parent binds messages to the actual iframe and site; a random per-document nonce prevents stale responses settling calls after reload. The iframe stays sandboxed without `allow-same-origin` and receives neither Batty credentials nor connection secrets.

## Host-admin connection grants

An administrator grants a specific site access to a specific API through Batty's Environment settings, separately from site/function authoring. Set `BATTY_SITE_CONNECTIONS` to a JSON object keyed by the exact site UUID and connection name:

```json
{
  "<site UUID>": {
    "images": {
      "url": "https://trusted-api.example/generate",
      "secretHeaders": {
        "Authorization": { "env": "BATTY_SITE_SECRET_IMAGE_API_KEY", "prefix": "Bearer " }
      }
    }
  }
}
```

Set `BATTY_SITE_SECRET_IMAGE_API_KEY` separately to the API key through Environment settings. Only the `BATTY_SITE_SECRET_*` namespace is accepted. `headers` supports non-secret literals. Do not put secret values in function code, URLs, registration arguments, HTML, or model/tool outputs.

A grant authorizes the combination of **site + connection + HTTPS destination + credential**. Function code and registration cannot modify these bindings, select other environment variables, override URLs/headers, or reuse another site's grant. Grants enable spending at that API; approve the intended API scope and account budget. Updating/removing a host grant takes effect on subsequent invocations. Public static sharing does not grant execution access.

## Function API

Code runs in QuickJS, not Node:

- `await tools.input()` returns the JSON passed to `batty.call`.
- `await tools.request({ connection, method, body, path })` calls a granted HTTPS connection and returns parsed JSON. Default method is POST; GET, PUT, PATCH and DELETE are also supported. `body` is encoded as JSON.

To use an optional relative `path` (e.g. `request-id/status`), the granted URL must end in `/` and have no query. The resolved URL must remain within its origin and path prefix; encoded traversal/separators are rejected. A path prefix is not a replacement for upstream API authorization. Redirects are rejected. Outbound connections support public IPv4 on HTTPS port 443 only: DNS answers are checked and the selected address is pinned while TLS verifies the original hostname. Loopback, private, link-local/metadata, shared, multicast and reserved destinations are blocked. IPv6-only endpoints are unsupported.

There is no filesystem, process, module loading, unrestricted fetch, persistent store, shell/tool access, or background job runtime. For queued APIs, return the job ID and call a status function from the client; each invocation is independent.

## Execution and limits

Backend execution requires Linux, root-managed systemd, and `ldd`. It fails closed if isolation is unavailable; static sites remain cross-platform. No per-site app service is installed.

Each invocation starts an ephemeral systemd unit under a fresh unprivileged DynamicUser. Its minimal root filesystem contains only a copied Node executable, its linked libraries, the worker and QuickJS packages. There are no host directory mounts. The runtime is read-only, `/tmp` and `/var/tmp` are blocked, `TMPDIR=/work` is an 8 MiB tmpfs, networking is disabled, and only a cleared environment and stdin/stdout/stderr cross the boundary. Capabilities, privilege escalation and namespaces are restricted; kernel/control-group interfaces and other processes are protected.

QuickJS has a 60-second deadline and 32 MiB heap. The OS unit caps memory at 256 MiB with no swap, CPU at one core, tasks at sixteen and runtime at 65 seconds, with a one-second stop timeout. The parent deadline is 70 seconds. Four invocations are admitted process-wide; slots remain occupied until the actual unit/cgroup is stopped. HTTP requests are limited to twelve per invocation, with 4 MiB request/response/result limits, bounded stdout/stderr and strict IPC validation. Calls fail rather than queue when busy. Runtime staging is shared per Batty process and removed on shutdown; invocations persist no application state.

## Security boundary

Assume malicious site JavaScript/input, malicious function behavior, malformed HTTP replies, and arbitrary Node execution after a VM escape. The isolated process cannot read Batty state or secrets, write host files, make direct network connections, or gain broader broker capabilities. The privileged parent accepts only a connection name, supported method, JSON body and constrained path; unknown fields, duplicate IDs, extra terminal messages and oversized output terminate the unit. Cleanup stops the cgroup, not merely the local launcher.

The root broker inserts credential headers after the worker selects an approved capability. Secret values never enter the worker or durable/model call logs. Header/transport errors are sanitized; decoded literal secret echoes are redacted before returning JSON. This does not protect against a malicious approved upstream deliberately encoding or exfiltrating credentials it receives: grants must point at trusted services.

Host administrators and agents with existing root shell/file access remain trusted administrators; this feature does not sandbox that existing authority or provide untrusted multi-tenant hosting. Batty login and same-origin POST checks protect execution; read-only preview tokens cannot authorize it. OS isolation reduces the impact of a VM/runtime flaw but does not claim protection against kernel vulnerabilities.
