# WP2 cache test: does changing the reasoning effort between messages of one Claude Code thread
# make the next request rewrite the cached context?
#   python3 -I scripts/measure/wp2_cache.py PROJECT ENVIRONMENT OUT.json
#   python3 -I scripts/measure/wp2_cache.py --thread THREAD OUT.json    (only reads a finished test thread)
# One Opus 5.5 thread reads about 50k tokens of files, then gets short questions at medium, medium,
# low, high and medium effort. For the first request of each turn it prints the cache read and write.
import datetime, json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paired import EPOCH, bb, completed_turns, session_ids, transcripts, wait_turn
from prices import usd
from sources import claude, when

FIRST = ("Read packages/viewer/src/Configuration.ts and packages/viewer/src/connect.ts in full with the Read tool. "
         "Then reply with only the word done. Change no files.")
QUESTIONS = [
    ("medium", "In one sentence, what does connect.ts export? Do not use any tools."),
    ("low", "In one sentence, name one option that Configuration.ts defines. Do not use any tools."),
    ("high", "In one sentence, name a second option that Configuration.ts defines. Do not use any tools."),
    ("medium", "In one sentence, name a third option that Configuration.ts defines. Do not use any tools."),
]

def turns_of(thread):
    """Each turn's start and the reasoning level BB sent with it, from the thread log."""
    log = json.loads(bb("thread", "log", thread, "--all", "--json"))
    levels = [e["data"]["execution"]["reasoningLevel"] for e in log if e["type"] == "client/turn/requested"]
    starts = [when(e["createdAt"]) for e in log if e["type"] == "turn/started"]
    return [{"effort": level, "startedAt": start} for level, start in zip(levels, starts)]

def analyze(thread, out):
    turns = turns_of(thread)
    rs = sorted(claude(EPOCH, paths=[f for f in transcripts(session_ids(thread)) if "/subagents/" not in f]), key=lambda r: r["ts"])
    rows = []
    for i, t in enumerate(turns):
        end = turns[i + 1]["startedAt"] if i + 1 < len(turns) else datetime.datetime.max.replace(tzinfo=datetime.timezone.utc)
        mine = [r for r in rs if t["startedAt"] <= r["ts"] < end]
        first = mine[0]
        rows.append({"effort": t["effort"], "requests": len(mine), "firstRead": first["read"],
                     "firstWrite": first["w5"] + first["w1h"], "firstNew": first["new"],
                     "output": sum(r["out"] for r in mine), "turnUsd": sum(sum(usd(r).values()) for r in mine)})
        print(f"turn {i + 1} {t['effort']:6} requests {len(mine)} first request: read {first['read']} "
              f"write {rows[-1]['firstWrite']} new {first['new']} | output {rows[-1]['output']} | turn ${rows[-1]['turnUsd']:.3f}")
    json.dump({"thread": thread, "turns": rows}, open(out, "w"), indent=1)

def main():
    if sys.argv[1] == "--thread":
        return analyze(sys.argv[2], sys.argv[3])
    project, environment, out = sys.argv[1:4]
    thread = json.loads(bb("thread", "spawn", "--json", "--parent-self", "--project", project, "--environment", environment,
                           "--provider", "claude-code", "--model", "claude-opus-5-5", "--reasoning-level", "medium",
                           "--title", "measure wp2 cache test", "--prompt-file", "-", stdin=FIRST))["id"]
    assert wait_turn(thread, 0) == "done"
    for effort, question in QUESTIONS:
        before = completed_turns(thread)
        bb("thread", "tell", thread, "--reasoning-level", effort, "--message-file", "-", stdin=question, as_user=True)
        assert wait_turn(thread, before) == "done"
    bb("thread", "stop", thread)
    analyze(thread, out)

if __name__ == "__main__":
    main()
