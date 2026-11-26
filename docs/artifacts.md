# Artifacts

The private library lists uploads, imported/generated files (including worker evidence), and local sites with a usable home page. Identical generated files with the same name share a row; original refs and downloads stay intact. Text files open in a read-only code view. Long previews are shortened; downloads retain the full file. Sites open their current version. Starred items appear first, then newest first. Diffs and live browsers stay on messages.

Use `import_files` or `sites` with `action: "create"` to get refs. To attach them to a reply, including a cron or worker final, append a blank line followed by:

```text
<batty-attachments>{"artifactRefs":["file:<id>","site:<id>"]}</batty-attachments>
```

For an intermediate report: `subagent({action: "report", prompt: "…", artifactRefs: ["file:<id>"]})`. Either accepts `browserId` for a live browser in the current workspace. Selection does not create a browser or extend its lifetime.

Only selected files cross installations. File refs also work as explicit inputs to a worker assignment.

Existing instances require the [one-time presentation migration](artifact-presentation-migration.md).
