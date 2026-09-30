# MCP

Batty uses Pi's native MCP extension for stdio and streamable HTTP servers. MCP tools are available through codemode by default; Pi owns discovery, naming, connections, OAuth, and tool execution.

## Configuration

Manage servers in **Settings → MCP servers**. The list shows global servers first, followed by workspace servers with their workspace names. **Add server** opens the editor: enable **Global**, or select a workspace. Workspace entries replace global entries with the same name. Global connection actions use the selected workspace.

Configuration files:

- Global: `<Batty root>/.batty/mcp.json`
- Workspace: `<workspace>/.batty/mcp.json`
- OAuth credentials: `<Batty root>/.batty/mcp-auth.json`
- Server logs: `<Batty root>/.batty/mcp.log`

```json
{
  "mcpServers": {
    "local": {
      "command": "node",
      "args": ["/absolute/path/server.mjs"],
      "exposure": "codemode"
    },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    }
  }
}
```

`env` and `headers` support Pi's environment-variable and command references. Environment variables can be managed in Batty settings. `command` is an executable; its arguments belong in `args`. Legacy SSE transport is not supported.

Changes through settings reload idle sessions. Busy sessions finish their admitted work before reloading. Hand-edited files are read when a session is created or its resources reload. Reconnect after changing connection environment variables.

## Exposure

- `codemode`: callable from scripts and listed in the codemode description.
- `codemode-deferred`: callable from scripts; discover with `searchTools`, `describeTool`, or `ALL_TOOLS`.
- `deferred`: discover through Pi's `tool_search`, then call directly; also callable from codemode.
- `direct`: declared directly to the model and callable from codemode.
- `hidden`: unavailable.

`toolExposure` overrides individual tools by exact name or glob pattern. Pi's normalized tool names look like `mcp__server__tool`.

```js
const result = await tools.mcp__remote__search({ query: "example" });
text(result.structuredContent ?? result.content);
```

Scripts receive the native MCP result, including `content`, `structuredContent`, and `isError`. `image(result.content[0])` forwards an image. Native resource tools are also available when a server advertises resources.

## OAuth

For an HTTP server without an Authorization header, choose **Sign in**, open the authorization link, and approve access. If the browser cannot reach the server's loopback callback, paste the final redirect URL into Batty. Pi handles registration, PKCE, callback-state validation, token exchange, and refresh. Sign out removes the URL-keyed credentials.

Sign-in attempts are process-local. Closing the sign-in flow cancels it. Model-provider credentials are stored separately.

## Connections

Each agent session owns its MCP connections, including separate stdio processes. Cron and subagent sessions use the same configuration rules. The web manager uses temporary native sessions when it needs to inspect or manage servers; these connections close after the operation. No Batty-specific MCP transport or tool catalog is maintained.
