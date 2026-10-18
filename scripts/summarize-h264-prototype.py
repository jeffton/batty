"""Analyze isolated prototype traces. Pointer and canvas clocks are identical."""
import json
import math
import sys


def quantiles(values):
    values = sorted(values)
    return {"n": len(values), "p50": round(values[math.ceil(len(values) * .5) - 1], 2),
            "p95": round(values[math.ceil(len(values) * .95) - 1], 2)} if values else {"n": 0}


for filename in sys.argv[1:]:
    with open(filename, encoding="utf-8") as source:
        data = json.load(source)
    paints = [r for r in data["client"]["trace"] if r["stage"] == "paint"]
    inputs = data["client"]["inputs"]
    latencies = []
    if not data["continuous"]:
        for trial in range(1, data["trials"] + 1):
            moves = [r for r in inputs if r["trial"] == trial and r["phase"] == "move"]
            scrolls = [r for r in data["scrolls"] if r["trial"] == trial]
            if len(moves) != 1 or len(scrolls) != 1:
                raise RuntimeError(f"Trial {trial} is not a single-move/single-scroll trial")
            matched = [r for r in paints if r["mark"] == scrolls[0]["mark"] and r["time"] >= moves[0]["time"]]
            if not matched:
                raise RuntimeError(f"Trial {trial} has no corresponding painted pixels")
            latencies.append(matched[0]["time"] - moves[0]["time"])
    duration = (data["ended"] - data["began"]) / 1000
    down = [r for r in data["relayRecords"] if r["direction"] == "down" and data["began"] <= r["time"] <= data["ended"]]
    # Viewer first move to release is on one client clock; count actual frames and changed markers.
    active_inputs = [r for r in inputs if r["phase"] == "move"]
    start, end = active_inputs[0]["time"], inputs[-1]["time"]
    active_paints = [r for r in paints if start <= r["time"] <= end]
    last = None
    changed = 0
    for row in active_paints:
        if row["mark"] != last:
            changed += 1
            last = row["mark"]
    print(json.dumps({"file": filename, "codec": data["mode"], "profile": data["profile"],
                      "continuous": data["continuous"], "input_to_canvas_ms": quantiles(latencies),
                      "duration_seconds": round(duration, 3), "tcp_down_bytes": sum(r["bytes"] for r in down),
                      "tcp_down_mbit": round(sum(r["bytes"] for r in down) * 8 / duration / 1e6, 3),
                      "displayed_fps": round(len(active_paints) / ((end-start)/1000), 2),
                      "changed_marker_fps": round(changed / ((end-start)/1000), 2),
                      "cpu_tree_core_percent": round(data["cpuTreeCorePercent"], 1),
                      "static_psnr_db": round(data["psnrDb"], 2), "safari_support": data["safariSupport"],
                      "safari_decoded": data["safariDecoded"], "image_directory": data["root"]}, indent=2))
