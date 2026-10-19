# Prices replayed routes: each past session's own main-chain requests, repriced at the model that a
# route file picked for it. Same tokens, other model, so it shows what a routing change moves.
#   python3 -I scripts/measure/replay_cost.py ROUTES_A.jsonl ROUTES_B.jsonl
# A route file has one {"file", "route": {"model"}} per line, as route_all.py writes it.
# Sessions whose transcript Claude Code already deleted are skipped and counted.
import collections, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paired import EPOCH
from prices import usd
from sources import claude

def priced(files):
    out = {}
    for f in files:
        if os.path.exists(f):
            out[f] = [r for r in claude(EPOCH, paths=[f]) if not r["helper"]]
    return out

def main():
    a, b = ({r["file"]: r["route"]["model"] for r in map(json.loads, open(p)) if "route" in r} for p in sys.argv[1:3])
    files = sorted(set(a) & set(b))
    requests = priced(files)
    totals, moved = collections.Counter(), collections.Counter()
    for f, rs in requests.items():
        x = sum(sum(usd(r, a[f]).values()) for r in rs)
        y = sum(sum(usd(r, b[f]).values()) for r in rs)
        totals["a"] += x; totals["b"] += y
        if a[f] != b[f]:
            moved[(a[f], b[f])] += 1
            totals[f"{a[f]} -> {b[f]}"] += y - x
    print(f"{len(files)} sessions in both files, {len(requests)} priced, {len(files) - len(requests)} transcripts deleted")
    print(f"A ${totals['a']:.2f}, B ${totals['b']:.2f}, difference ${totals['b'] - totals['a']:+.2f} ({(totals['b'] / totals['a'] - 1) * 100:+.1f}%)")
    for (x, y), n in moved.most_common():
        print(f"  {n:3} moved {x} -> {y}: ${totals[f'{x} -> {y}']:+.2f}")

if __name__ == "__main__":
    main()
