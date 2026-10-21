#!/usr/bin/env python3
"""Validate an opt-in Caddyfile and render its per-user launch agent."""
import os
import plistlib
import shutil
import subprocess
import sys

https_root, target, label, logs = sys.argv[1:]
caddy = shutil.which("caddy")
if caddy is None:
    sys.exit("Install Caddy for HTTPS deployment: brew install caddy")
config = os.path.join(https_root, "Caddyfile")
subprocess.run(
    [caddy, "validate", "--config", config, "--adapter", "caddyfile"],
    cwd=https_root,
    check=True,
)
with open(target, "wb") as handle:
    plistlib.dump(
        {
            "Label": label + ".https",
            "ProgramArguments": [caddy, "run", "--config", config, "--adapter", "caddyfile"],
            "WorkingDirectory": https_root,
            "EnvironmentVariables": {"HOME": os.path.expanduser("~")},
            "RunAtLoad": True,
            "KeepAlive": True,
            "ThrottleInterval": 2,
            "StandardOutPath": logs + "/https.log",
            "StandardErrorPath": logs + "/https-error.log",
        },
        handle,
    )
