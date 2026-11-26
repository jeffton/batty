# Artifacts

The private library lists incoming uploads, imported file snapshots, and local sites. Starred items come first, then newest first. Files are immutable; sites open their current version. Diffs and live browsers stay on messages.

Use `import_files` or `sites` with `action: "create"` to get refs. To attach them to a reply, including a cron or worker final, append a blank line followed by:

```text
<batty-attachments>{"artifactRefs":["file:<id>","site:<id>"]}</batty-attachments>
```

For an intermediate report: `subagent({action: "report", prompt: "…", artifactRefs: ["file:<id>"]})`. Either accepts `browserId` for a live browser in the current workspace. Selection does not create a browser or extend its lifetime.

Only selected files cross installations. File refs also work as explicit inputs to a worker assignment.

Existing instances require the [one-time presentation migration](artifact-presentation-migration.md).
