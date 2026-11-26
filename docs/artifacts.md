# Artifacts

The Sites button opens the most recently viewed local site, or the newest site if none has been viewed. Use **Choose site** in the preview header to switch sites.

Files are available from their messages, including worker reports. Text files open in a read-only code view, with wrap and full download. Diffs and live browsers stay on messages.

Use `import_files` or `sites` with `action: "create"` to get refs. To attach them to a reply, including a cron or worker final, append a blank line followed by:

```text
<batty-attachments>{"artifactRefs":["file:<id>","site:<id>"]}</batty-attachments>
```

For an intermediate report: `subagent({action: "report", prompt: "…", artifactRefs: ["file:<id>"]})`. Either accepts `browserId` for a live browser in the current workspace. Selection does not create a browser or extend its lifetime.

Only selected files cross installations. File refs also work as explicit inputs to a worker assignment.

Existing instances require the [one-time presentation migration](artifact-presentation-migration.md).
