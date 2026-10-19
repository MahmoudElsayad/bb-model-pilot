# Prices the main agent of each run by user message, so a change that affects only later messages
# can be measured apart from the first one.
#   python3 -I scripts/measure/turn_cost.py OUT [--prefix m]
# A request counts toward the last user message sent before it. Helper transcripts are left out.
import argparse, collections, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paired import EPOCH, bb, session_ids, transcripts
from prices import usd
from sources import claude, when

def user_starts(thread):
    log = json.loads(bb("thread", "log", thread, "--all", "--json"))
    return [when(e["createdAt"]) for e in log
            if e["type"] == "client/turn/requested" and e["data"].get("initiator") == "user"]

def main():
    a = argparse.ArgumentParser()
    a.add_argument("out")
    a.add_argument("--prefix", default="m")
    o = a.parse_args()
    totals = collections.defaultdict(lambda: collections.Counter())
    for r in map(json.loads, open(f"{o.out}/runs.jsonl")):
        if not r["task"].startswith(o.prefix):
            continue
        starts = user_starts(r["thread"])
        per = collections.Counter()
        for q in claude(EPOCH, paths=[f for f in transcripts(session_ids(r["thread"])) if "/subagents/" not in f]):
            i = sum(q["ts"] >= s for s in starts) - 1
            if i >= 0:
                per[i] += sum(usd(q).values())
        totals[r["arm"]].update(per)
        print(f"{r['task']:7} {r['arm']:8} " + " ".join(f"message {i + 1} ${per[i]:.3f}" for i in sorted(per)))
    for arm, per in totals.items():
        print(f"{arm}: " + ", ".join(f"message {i + 1} ${per[i]:.2f}" for i in sorted(per)))

if __name__ == "__main__":
    main()
