# Batty

A personal assistant and coding agent with **one permanent main thread**. Research, coding, background tasks and scheduled work branch out from that conversation and bring their results back. Persistent memory carries the context forward.

## Pi Durable

[Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable) powers execution. Conversations, tasks and result delivery persist in SQLite; committed work resumes after server restarts, including during deployments.

- **Async subagents:** delegate parallel work, `await` results, `steer` running agents and `resume` previous agents for follow-ups.
- **Cron:** scheduled and one-off tasks, with results delivered directly or through the main assistant.
- **Workspaces:** project directories with their own instructions and skills; execution scopes, not separate user chats.
- **Coding tools:** read, write and edit files, search repositories and run shell commands.
- **Browser and web search:** interact with JavaScript-driven pages, capture screenshots and extract readable web content.
- **Codemode, MCP and skills:** compose tool calls in JavaScript, discover external MCP tools and load reusable workflows.
- **Artifacts:** return files, diffs and hosted HTML sites; forward selected artifacts from worker reports.
- **Mobile web app:** installable PWA, passkey login, push notifications, offline history reading and incremental reconnect.
- **Model controls:** choose models and reasoning effort for the main assistant, subagents and scheduled work; inspect token usage.

## OptChat

[OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) gives the permanent conversation a navigable memory tree. Original history is retained; hierarchical summaries keep older context available without sending the entire archive on every turn.

- `memory_zoom` expands summaries or retrieves original non-thought text.
- `memory_date` retrieves the timestamp of an original entry.
- `memory_search` searches original text by literal words.

Main runs receive a prepared memory overview. Workers in the assistant's workspace can use that same main history. The summarization model and language are configurable; original messages remain unchanged.

## Documentation

- [Setup, development and operation](docs/operations.md)
- [Runtime, memory and integrations](docs/runtime.md)
- [Importing history and migrating sites or schedules](docs/migration.md)
- [Client API](src/client/API.md)

## References

- [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)
- [OptChat specification](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)
