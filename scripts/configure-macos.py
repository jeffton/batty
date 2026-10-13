#!/usr/bin/env python3
"""Render the launch agent and cron CLI for one macOS installation."""
import json
import os
import plistlib
import shlex
import sys

old, target, label, node, current, root, logs, path, cli = sys.argv[1:]
if os.path.exists(old):
    with open(old, "rb") as handle:
        agent = plistlib.load(handle)
else:
    agent = {}
agent.pop("Program", None)
agent.update(
    Label=label,
    ProgramArguments=[node, current + "/dist/server/main.mjs", root],
    WorkingDirectory=current,
    RunAtLoad=True,
    KeepAlive=True,
    ThrottleInterval=2,
    StandardOutPath=logs + "/batty.log",
    StandardErrorPath=logs + "/batty-error.log",
)
env = agent.setdefault("EnvironmentVariables", {})
env.setdefault("BATTY_HOST", "127.0.0.1")
env.setdefault("BATTY_PORT", "3147")
env.update(BATTY_SELF_PATH=current, PATH=path)
# The server loads stored environment settings over launchd's environment.
environment_file = os.path.join(root, ".batty", "environment.json")
if os.path.exists(environment_file):
    with open(environment_file) as handle:
        environment = json.load(handle)
    for name in ("BATTY_HOST", "BATTY_PORT"):
        if name in environment:
            env[name] = environment[name]
with open(target, "wb") as handle:
    plistlib.dump(agent, handle)

# CLI config must use the same listener as the launch agent, outside launchd.
command = [
    "env",
    "BATTY_HOST=" + env["BATTY_HOST"],
    "BATTY_PORT=" + env["BATTY_PORT"],
    node,
    current + "/dist/server/cron-cli.mjs",
    "--root",
    root,
]
with open(cli, "w") as handle:
    handle.write('#!/bin/bash\nexec ' + shlex.join(command) + ' "$@"\n')
os.chmod(cli, 0o755)
