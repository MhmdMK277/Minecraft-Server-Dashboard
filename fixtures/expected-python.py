"""Emit what the PYTHON implementation (mcbackup.py) computes for each fixture.

Only the surface both implementations genuinely share is emitted:
  - player count parsing        (mcbackup.player_count)
  - SLP readiness detection     (mcbackup._ping_is_ready)
  - SLP payload normalisation   (the normaliser inside mcbackup.slp_ping)
  - world folder resolution     (mcbackup.world_dirs / level_dat_path)
  - directory classification    (mcbackup.discover_servers)
  - process identity            (mcbackup.pid_of_server)

TPS parsing is deliberately absent: the backup script does not parse TPS, so
there is nothing to cross-validate against. The dashboard's TPS parsers are
tested against the captured raw fixtures instead.
"""
import json, os, re, sys

sys.path.insert(0, os.environ.get("MCBACKUP_DIR", os.path.expanduser("~/mcbackup")))
import mcbackup as m

HERE = os.path.dirname(os.path.abspath(__file__))
servers = json.load(open(os.path.join(HERE, "servers.json"), encoding="utf-8"))
samples = json.load(open(os.path.join(HERE, "samples.json"), encoding="utf-8"))

out = {"playerCount": {}, "slpReady": {}, "worlds": {}, "discovery": {}, "identity": {}}


class FakeRcon:
    """player_count() takes an rcon object; feed it a captured string."""
    def __init__(self, text):
        self.text = text

    def run(self, _cmd):
        return self.text


for name, entry in samples["rcon"].items():
    if not entry.get("connected"):
        continue
    raw = entry["commands"].get("list", {}).get("raw")
    if raw is None:
        continue
    count, _ = m.player_count(FakeRcon(raw))
    out["playerCount"][name] = {"raw": raw, "online": count}

for name, entry in samples["slp"].items():
    if "parsed" not in entry:
        continue
    out["slpReady"][name] = m._ping_is_ready(entry["parsed"])

for e in servers:
    d = e["dir"]
    lvl = m.level_dat_path(d)
    out["worlds"][e["name"]] = {
        "worldDirs": m.world_dirs(d),
        "levelDat": os.path.relpath(lvl, d).replace("\\", "/") if lvl else None,
    }

found, rejected = m.discover_servers(m.SERVERS_ROOT)
out["discovery"] = {
    "servers": sorted(n for n, _ in found),
    "notServers": sorted(rejected),
}

for e in servers:
    if e["isServer"]:
        out["identity"][e["name"]] = m.pid_of_server(e["dir"]) is not None

# Normalisation: feed the tricky shapes through the python normaliser.
def py_normalise(text):
    data = json.loads(text)
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except (ValueError, TypeError):
            return {"version": {"name": data}}
    if not isinstance(data, dict):
        return {"version": {"name": str(data)}}
    return data


CASES = {
    "object": '{"version":{"name":"Paper 1.21.4"}}',
    "double-encoded": json.dumps(json.dumps({"version": {"name": "1.7.10"}})),
    "bare-string": json.dumps("Server is still starting! Please wait before reconnecting."),
}
out["normalise"] = {k: py_normalise(v) for k, v in CASES.items()}
out["normaliseInput"] = CASES

json.dump(out, open(os.path.join(HERE, "expected-python.json"), "w", encoding="utf-8"),
          indent=2, ensure_ascii=False)
print("wrote expected-python.json")
for k, v in out.items():
    if isinstance(v, dict):
        print(f"  {k}: {len(v)} entries")
