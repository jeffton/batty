"""Summarize offline traces from benchmark-cloud-stages.ts; all times in host ms."""
import json
import math
import sys
from collections import defaultdict


def quantiles(values):
    values = sorted(values)
    return {"n": len(values), "p50": round(values[math.ceil(len(values) * .5) - 1], 2),
            "p95": round(values[math.ceil(len(values) * .95) - 1], 2)} if values else {"n": 0}


all_stages = defaultdict(list)
profile = None
for filename in sys.argv[1:]:
    with open(filename, encoding="utf-8") as source:
        data = json.load(source)
    if profile is None:
        profile = data["profile"]
    elif profile != data["profile"]:
        raise RuntimeError("Cannot pool different profiles or workloads")
    viewer_offset = data["clocks"]["viewerClock"]["offset"]
    remote_offset = data["clocks"]["remoteClock"]["offset"]
    stages = defaultdict(list)
    client = data["client"]
    server = data["traces"]
    for name in ["viewer", "remote"]:
        start = data["clocks"][name + "Clock"]
        end = data["clocks"]["end" + name.title() + "Clock"]
        if abs(start["offset"] - end["offset"]) > start["uncertainty"] + end["uncertainty"] + 1:
            raise RuntimeError("Clock drift exceeds calibration bound")
    if any(r.get("commandId") is None for r in server if r["stage"] in ["server-receive", "cdp-dispatch"]):
        raise RuntimeError("Missing explicit server command ID")
    grouped = defaultdict(dict)
    for event in client:
        if "frameId" in event:
            grouped[event["frameId"]][event["stage"]] = event["time"] + viewer_offset
    sent = {r["frameId"]: r for r in server if r["stage"] == "ws-send"}
    inputs = {r["inputId"]: r for r in client if r["stage"] == "input"}
    sends = [r for r in client if r["stage"] == "client-send"]
    def key(command):
        return json.dumps(command, sort_keys=True)
    received = {key(r["command"]): r for r in server if r["stage"] == "server-receive"}
    operations = {key(r["command"]): r for r in server if r["stage"] == "operation-start"}
    entered = {key(r["command"]): r for r in server if r["stage"] in ["service-guard", "queue-enter"]}
    dispatches = [r for r in server if r["stage"] == "cdp-dispatch"]
    acks = {r["params"]["timestamp"]: r for r in server if r["stage"] == "cdp-ack"}
    moves = {}
    used_dispatches = set()
    for item in sends:
        command = item["command"]
        elapsed = key(command)
        if elapsed not in received:
            continue
        recv = received[elapsed]["time"]
        stages["input_to_send"].append(item["time"] - inputs[item["inputId"]]["time"])
        stages["send_to_server_receive"].append(recv - item["time"] - viewer_offset)
        if elapsed not in operations:
            continue  # server coalesced a pending move
        op = operations[elapsed]["time"]
        enter = entered[elapsed]["time"]
        phase = {"start": "touchStart", "move": "touchMove", "end": "touchEnd", "cancel": "touchCancel"}[command["phase"]]
        candidates = [r for r in dispatches if r["params"]["type"] == phase
                      and r["time"] >= enter and r["time"] not in used_dispatches
                      and r["commandId"] == received[elapsed]["commandId"]]
        if phase in ["touchStart", "touchMove"]:
            candidates = [r for r in candidates if r["params"]["touchPoints"][0]["x"] == command["x"]
                          and r["params"]["touchPoints"][0]["y"] == command["y"]]
        if len(candidates) != 1:
            raise RuntimeError("Executed command did not match exactly one CDP dispatch")
        dispatch = candidates[0]
        used_dispatches.add(dispatch["time"])
        if dispatch["time"] - enter > 20:
            raise RuntimeError("CDP dispatch did not immediately follow service guard")
        ack = acks[dispatch["params"]["timestamp"]]["time"]
        stages["receive_to_operation"].append(op - recv)
        stages["operation_to_service_guard"].append(enter - op)
        stages["service_guard_to_cdp_send"].append(dispatch["time"] - enter)
        stages["cdp_send_to_ack"].append(ack - dispatch["time"])
        stages["cdp_send_to_ack_" + phase].append(ack - dispatch["time"])
        if command["phase"] == "move":
            moves[(item.get("trial", 1), command["y"])] = {"input": inputs[item["inputId"]]["time"] + viewer_offset,
                                   "send": item["time"] + viewer_offset, "receive": recv,
                                   "inputId": item["inputId"], "commandId": received[elapsed]["commandId"],
                                   "dispatch": dispatch["time"], "ack": ack}
    scrolls = {r["mark"]: r for r in data["scrolls"]}
    seen = set()
    seen_trials = set()
    rows = []
    correlations = []
    for frame_id, frame in sorted(grouped.items()):
        if "paint" not in frame or frame_id not in sent:
            continue
        wire = sent[frame_id]
        matches = [r for r in data["captures"] if r["hash"] == wire["hash"] and r["time"] <= wire["time"]]
        if not matches:
            raise RuntimeError(f"Frame {frame_id} missing capture")
        capture = matches[-1]
        mark = capture["mark"]
        if not mark or mark in seen or mark not in scrolls:
            continue
        scroll = scrolls[mark]
        move_key = (scroll.get("trial", 1), scroll["inputY"])
        if capture["time"] > data["lifted"] or move_key not in moves:
            continue  # exclude fling and paints without a correlated native touchmove
        if data["profile"].get("workload") == "settled" and scroll["trial"] in seen_trials:
            continue
        if data["profile"].get("workload") == "settled" and len(matches) != 1:
            raise RuntimeError("Ambiguous JPEG hash in a selected settled response")
        move = moves[move_key]
        scroll_time = scroll["time"] + remote_offset
        if scroll_time < move["dispatch"] - 3:
            raise RuntimeError("Remote scroll precedes correlated input; clock/correlation invalid")
        seen.add(mark)
        seen_trials.add(scroll.get("trial", 1))
        row = {
            "input_to_send_reflected": move["send"] - move["input"],
            "send_to_receive_reflected": move["receive"] - move["send"],
            "receive_to_dispatch_reflected": move["dispatch"] - move["receive"],
            "dispatch_to_scroll_event": scroll_time - move["dispatch"],
            "scroll_event_to_screencast_receipt": capture["time"] - scroll_time,
            "screencast_receipt_to_ws_send": wire["time"] - capture["time"],
            "ws_send_to_client_receive": frame["client-receive"] - wire["time"],
            "receive_to_decode_start": frame["decode-start"] - frame["client-receive"],
            "decode": frame["decode-end"] - frame["decode-start"],
            "decode_to_canvas_paint": frame["paint"] - frame["decode-end"],
            "input_to_canvas_paint": frame["paint"] - move["input"],
            "frame_bytes": wire["bytes"],
            "server_buffered_bytes": wire["buffered"],
        }
        correlations.append({"trial": scroll.get("trial", 1), "inputId": move["inputId"],
                             "commandId": move["commandId"], "marker": mark,
                             "captureId": capture["captureId"], "frameId": frame_id})
        for name, value in row.items():
            stages[name].append(value)
        rows.append(row)
    if data["profile"].get("workload") == "settled" and len(seen_trials) != 40:
        raise RuntimeError(f"Expected 40 correlated settled trials, got {len(seen_trials)}")
    for name, values in stages.items():
        all_stages[name].extend(values)
    # TCP relay counts include WS framing/HTTP. Restrict to release timestamps inside the drag.
    down = [r for r in data["relayRecords"] if r["direction"] == "down" and data["began"] <= r["released"] <= data["lifted"]]
    span = (data["lifted"] - data["began"]) / 1000
    relay = {"drag_seconds": round(span, 3), "down_released_bytes_during_drag": sum(r["bytes"] for r in down),
             "effective_down_mbit": round(sum(r["bytes"] for r in down) * 8 / span / 1e6, 3),
             "total_down_released_bytes": sum(r["bytes"] for r in data["relayRecords"] if r["direction"] == "down"),
             "received_frame_bytes_entire_trace": sum(r.get("bytes", 0) for r in client if r["stage"] == "client-receive")}
    counts = {"sent": len(sends), "server_received": len(received), "executed": len(operations),
              "coalesced": len(received) - len(operations), "screencast_received": len(data["captures"]),
              "transmitted": len(sent), "received_frames": len(grouped),
              "canvas_drawn": sum("paint" in frame for frame in grouped.values()), "correlated_rows": len(rows)}
    print(json.dumps({"counts": counts, "file": filename, "profile": data["profile"], "clock_bounds": data["clocks"],
                      "relay": relay, "stages": {k: quantiles(v) for k, v in stages.items()},
                      "first_reflected_frame": rows[0] if rows else None,
                      "correlations": correlations}, indent=2))
print(json.dumps({"pooled_stages": {k: quantiles(v) for k, v in all_stages.items()}}, indent=2))
