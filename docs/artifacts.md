# Response artifacts

Files, diffs, sites and live browsers belong to the execution scope that produced them. Subagent and cron reports list stable refs; `attach_artifacts` forwards selected received refs to the current response without rerunning their creation tools.

`browser` with `action: "open", cloud: true` and `action: "attach"` returns a live-browser attachment. Live browsers use `browser:` refs and the existing `sites` descriptor transport with `browserId`. The immutable descriptor points to the same mutable browser session: forwarding preserves its identity, login and lifetime. It neither creates a browser nor extends the inactivity timeout. Browser controls and streaming still require Batty authentication; forwarding does not publish access. A closed or expired browser stays unavailable through every forwarded attachment.
