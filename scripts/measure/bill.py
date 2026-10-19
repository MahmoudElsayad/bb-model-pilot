# Prints the bill of a period from every local agent log, by source, model and token category,
# and sorts the large cache writes by cause.
#   python3 -I scripts/measure/bill.py [--since 2026-09-01] [--until 2026-10-18] [--json out.json]
import argparse, collections, datetime, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prices import priced_as, usd
from sources import all_requests

CATS = ("write", "read", "new", "out")
LARGE = 40_000

def day(s):
    return datetime.datetime.fromisoformat(s).replace(tzinfo=datetime.timezone.utc)

def family(model):
    return next((k for k in ("haiku", "sonnet", "opus", "fable", "luna", "sol", "astra") if k in model), model)

def write_cause(prev, r):
    """Why one request wrote at least LARGE tokens to the cache, judged from the request before it in its transcript."""
    if prev is None:
        return "first request of a transcript"
    gap = (r["ts"] - prev["ts"]).total_seconds()
    if family(prev["model"]) != family(r["model"]):
        return "model switch"
    if gap > 3600:
        return "resume after the 1-hour cache expired"
    if prev["read"] > 20_000 and r["read"] < prev["read"] * 0.5:
        return "prefix broke within 1 hour"
    if gap > 300:
        return "gap of 5 to 60 minutes"
    return "large append within 5 minutes"

def main():
    a = argparse.ArgumentParser()
    a.add_argument("--since", default="2026-09-01")
    a.add_argument("--until")
    a.add_argument("--json")
    o = a.parse_args()
    rs = all_requests(day(o.since), day(o.until) if o.until else None)

    by = collections.defaultdict(lambda: collections.Counter())
    unpriced = collections.Counter()
    total = collections.Counter()
    for r in rs:
        c = usd(r)
        if c is None:
            unpriced[(r["source"], r["model"])] += r["new"] + r["w5"] + r["w1h"] + r["read"] + r["out"]
            continue
        k = by[(r["source"], priced_as(r["model"]))]
        k["requests"] += 1
        k["helper$"] += sum(c.values()) if r["helper"] else 0
        for cat in CATS:
            k[cat + "$"] += c[cat]
        k["write"] += r["w5"] + r["w1h"]; k["read"] += r["read"]; k["new"] += r["new"]; k["out"] += r["out"]
        total.update({cat: c[cat] for cat in CATS})

    bill = sum(total.values())
    print(f"Period {o.since} to {o.until or 'now'}: {len(rs):,} requests, ${bill:,.2f} at list prices")
    print(f"{'category':10} {'cost':>11} {'share':>6}")
    for cat, name in zip(CATS, ("cache write", "cache read", "uncached", "output")):
        print(f"{name:10} ${total[cat]:>10,.2f} {total[cat] / bill:>6.1%}")

    print(f"\n{'source':12} {'model':26} {'requests':>9} {'write':>10} {'read':>10} {'uncached':>9} {'output':>9} {'total':>10} {'share':>6} {'helpers':>9}")
    for (src, m), k in sorted(by.items(), key=lambda x: -sum(x[1][c + "$"] for c in CATS)):
        t = sum(k[c + "$"] for c in CATS)
        print(f"{src:12} {m:26} {k['requests']:>9,} ${k['write$']:>9,.0f} ${k['read$']:>9,.0f} ${k['new$']:>8,.0f} ${k['out$']:>8,.0f} ${t:>9,.2f} {t / bill:>6.1%} ${k['helper$']:>8,.0f}")
    print("\nTokens per category (millions):")
    for (src, m), k in sorted(by.items(), key=lambda x: -sum(x[1][c + "$"] for c in CATS))[:8]:
        print(f"  {src:12} {m:26} write {k['write'] / 1e6:8.1f}  read {k['read'] / 1e6:9.1f}  uncached {k['new'] / 1e6:7.1f}  output {k['out'] / 1e6:6.1f}")
    if unpriced:
        print("\nUnpriced (model not in routing/models.ts), tokens:")
        for (src, m), n in unpriced.most_common():
            print(f"  {src:12} {m:30} {n / 1e6:8.1f}M")

    # Large cache writes by cause, per transcript in time order.
    per_file = collections.defaultdict(list)
    for r in rs:
        if r["source"] == "claude-code" and priced_as(r["model"]):
            per_file[r["file"]].append(r)
    cause, n_cause = collections.Counter(), collections.Counter()
    write_total = large_total = 0.0
    for f, frs in per_file.items():
        frs.sort(key=lambda r: r["ts"])
        for i, r in enumerate(frs):
            w = usd(r)["write"]
            write_total += w
            if r["w5"] + r["w1h"] < LARGE:
                continue
            large_total += w
            c = write_cause(frs[i - 1] if i else None, r)
            cause[c] += w; n_cause[c] += 1
    print(f"\nClaude Code cache writes: ${write_total:,.2f}. Requests that wrote {LARGE // 1000}k+ tokens: "
          f"{sum(n_cause.values()):,}, ${large_total:,.2f} ({large_total / write_total:.0%} of write cost)")
    for c, v in cause.most_common():
        print(f"  {c:40} n={n_cause[c]:5,}  ${v:9,.2f}  {v / large_total:5.1%}")

    if o.json:
        json.dump({"since": o.since, "until": o.until, "requests": len(rs), "bill": bill, "categories": dict(total),
                   "byModel": [{"source": s, "model": m, **k} for (s, m), k in by.items()],
                   "largeWrites": {c: {"n": n_cause[c], "usd": v} for c, v in cause.items()},
                   "unpriced": [{"source": s, "model": m, "tokens": n} for (s, m), n in unpriced.items()]},
                  open(o.json, "w"), indent=1)

if __name__ == "__main__":
    main()
