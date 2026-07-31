"""Capture ground truth from the live machine into fixtures.

Both the Python backup script and the TypeScript dashboard are validated against
these, so the two cannot silently drift.

Secrets are never captured: rcon.password is read to talk to the server and is
then discarded. Nothing in the emitted JSON contains credential material.
"""
import json, os, re, sys, time

sys.path.insert(0, os.environ.get("MCBACKUP_DIR", os.path.expanduser("~/mcbackup")))
import mcbackup as m

OUT = os.path.dirname(os.path.abspath(__file__))
ROOT = m.SERVERS_ROOT

# Ground-truth classification, asserted by the operator, not inferred.
EXPECTED = {
    "MC 1.21.4":        "server-live",
    "MC 1.21.11":       "server-live",
    "MC GTNH":          "server-live",
    "MC Skyblock":      "server-live",
    "MC Tech":          "server-retired",
    "MC 1.21.4 - Copy": "server-stale",
    "MC 26.1":          "not-a-server",
    "clientpacks":      "not-a-server",
}

TPS_CMD = {"paper": "tps", "forge-modern": "forge tps", "forge-1710": "cofh tps"}


def detect_kind(d):
    """paper | forge-1710 | forge-modern | unknown, from directory contents."""
    has = lambda f: os.path.exists(os.path.join(d, f))
    if has("paper.jar") or os.path.isdir(os.path.join(d, "plugins")):
        return "paper"
    if has("lwjgl3ify-forgePatches.jar"):
        return "forge-1710"
    if os.path.isdir(os.path.join(d, "libraries", "net", "minecraftforge")):
        return "forge-modern"
    if os.path.isdir(os.path.join(d, "mods")):
        return "forge-modern"
    return "unknown"


servers = []
for name in sorted(os.listdir(ROOT)):
    d = os.path.join(ROOT, name)
    if not os.path.isdir(d):
        continue
    props = m.read_properties(os.path.join(d, "server.properties"))
    lvl = m.level_dat_path(d)
    kind = detect_kind(d) if lvl else "unknown"
    entry = {
        "name": name,
        "expectedClass": EXPECTED.get(name, "unknown"),
        "isServer": lvl is not None,
        "kind": kind,
        "levelName": props.get("level-name"),
        "worldDirs": m.world_dirs(d),
        "levelDatRelative": os.path.relpath(lvl, d).replace("\\", "/") if lvl else None,
        "gamePort": m.game_port_of(d),
        # rconPort is deliberately NOT captured: nothing reads it, and an RCON
        # port is operator information that must not enter the repo.
        "rconEnabled": props.get("enable-rcon", "false").lower() == "true",
        # NB: rcon.password deliberately absent.
        "expectedTpsCommand": TPS_CMD.get(kind),
    }
    servers.append(entry)

# ---- live samples: raw protocol/command output for parser cross-validation ----
samples = {"slp": {}, "rcon": {}, "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S")}

for e in servers:
    if not e["isServer"]:
        continue
    name = e["name"]
    d = os.path.join(ROOT, name)

    # Identity gate. Without this the fixtures bake in the very bug the spec
    # exists to prevent: MC Tech and "MC 1.21.4 - Copy" share ports with live
    # servers, so probing by port captured GTNH's status as MC Tech's and the
    # live 1.21.4's status as the Copy's. Only probe what actually has a PID.
    pid = m.pid_of_server(d)
    e["runningAtCapture"] = pid is not None
    if pid is None:
        samples["slp"][name] = {"skipped": "no process owns this directory"}
        samples["rcon"][name] = {"connected": False,
                                 "note": "no process owns this directory"}
        continue

    if e["gamePort"]:
        raw = m.slp_ping(e["gamePort"])
        if raw is not None:
            samples["slp"][name] = {
                "parsed": raw,
                "versionName": (raw.get("version") or {}).get("name")
                if isinstance(raw.get("version"), dict) else raw.get("version"),
                "playersOnline": (raw.get("players") or {}).get("online"),
                "playersMax": (raw.get("players") or {}).get("max"),
                "readyByMarker": m._ping_is_ready(raw),
            }

    rcon, note = m.connect_rcon(d)
    if rcon is None:
        samples["rcon"][name] = {"connected": False, "note": note}
        continue
    out = {"connected": True, "commands": {}}
    cmds = ["list"]
    if e["expectedTpsCommand"]:
        cmds.append(e["expectedTpsCommand"])
    # also record what the WRONG command returns, so parsers can be tested
    # against the misleading replies documented in the spec
    cmds += [c for c in ("tps", "forge tps", "cofh tps") if c not in cmds]
    for c in cmds:
        t = time.time()
        try:
            r = rcon.run(c)
        except Exception as exc:                                # noqa: BLE001
            r = f"<<ERROR {type(exc).__name__}>>"
        out["commands"][c] = {"raw": r, "ms": round((time.time() - t) * 1000, 1)}
    rcon.close()
    samples["rcon"][name] = out

# ---- scrub: assert no secret material leaked into the fixtures --------------
blob = json.dumps({"servers": servers, "samples": samples})
leaks = []
for e in servers:
    p = m.read_properties(os.path.join(ROOT, e["name"], "server.properties")).get("rcon.password", "")
    if p and len(p) > 10 and p in blob:
        leaks.append(e["name"])
if leaks:
    raise SystemExit(f"REFUSING TO WRITE: rcon password present for {leaks}")

json.dump(servers, open(os.path.join(OUT, "servers.json"), "w", encoding="utf-8"), indent=2)
json.dump(samples, open(os.path.join(OUT, "samples.json"), "w", encoding="utf-8"),
          indent=2, ensure_ascii=False)

print(f"wrote servers.json ({len(servers)} directories)")
print(f"wrote samples.json ({len(samples['slp'])} slp, {len(samples['rcon'])} rcon)")
print("credential scan: clean")
