# WP1 simulation: what compacting an idle Claude Code thread before its cache expires would have saved.
#   python3 -I scripts/measure/wp1_sim.py [--since 2026-09-01] [--until 2026-10-18] [--json out.json]
# The policy: at minute 55 of an idle gap, if the context is above X tokens and the model is Opus or Fable, compact.
# Keep-warm (a cache-read ping every 55 minutes for H hours) is reported for information only.
import argparse, collections, datetime, json, os, statistics, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prices import RATES, priced_as, usd
from sources import claude, deleted_claude

IDLE = 55 * 60
TTL_1H = 3600
SWEEP = (50_000, 100_000, 150_000, 200_000, 300_000)
HOURS = (2, 4, 8, 12)
PING_OUT = 50

def ctx(r):
    return r["read"] + r["w5"] + r["w1h"] + r["new"]

def family(model):
    m = priced_as(model) or ""
    return next((f for f in ("opus", "fable", "sonnet", "haiku") if f in m), None)

def cost(r):
    c = usd(r)
    return sum(c.values()) if c else 0.0

def sessions(rs):
    by = collections.defaultdict(list)
    for r in rs:
        if priced_as(r["model"]):
            by[(r["file"], r["helper"])].append(r)
    for v in by.values():
        v.sort(key=lambda r: r["ts"])
    return by

def compactions(reqs):
    """Indexes of requests right after an observed compaction: within one hour the context fell by more than half."""
    out = []
    for i in range(1, len(reqs)):
        a, b = reqs[i - 1], reqs[i]
        if (b["ts"] - a["ts"]).total_seconds() <= TTL_1H and ctx(a) > 20_000 and ctx(b) < ctx(a) * 0.5:
            out.append(i)
    return out

def summary_tokens(files):
    """Output size of a compaction summary, from the compact-summary messages that Claude Code writes."""
    sizes = []
    for f in files:
        if not os.path.exists(f):
            continue
        for line in open(f, errors="ignore"):
            if '"isCompactSummary":true' in line:
                c = json.loads(line)["message"]["content"]
                sizes.append(len(c if isinstance(c, str) else json.dumps(c)) / 4)
    return statistics.median(sizes) if sizes else 4000, len(sizes)

def simulate(by, x, compacted, summary, end, horizon=None):
    """Net saving of the policy at threshold x. After a compaction the simulated context stays smaller than the
    observed one until the next observed compaction, or, with `horizon`, for that many requests only. A compacted
    agent re-reads what it needs, so a short horizon is the cautious estimate."""
    t, resumed = collections.Counter(), set()
    for (f, helper), reqs in by.items():
        if helper:
            continue
        ttl1h = sum(r["w1h"] for r in reqs) >= sum(r["w5"] for r in reqs)
        observed = set(compactions(reqs))
        offset, since = 0, 0  # tokens that the simulated context holds fewer than the observed one
        for i, r in enumerate(reqs):
            since += 1
            if i in observed or (horizon is not None and since > horizon):
                offset = 0
            nxt = reqs[i + 1] if i + 1 < len(reqs) else None
            # Cost of request i in the simulated world, when an earlier compaction made the context smaller.
            if offset and (f, i) not in resumed:
                cut_read = min(offset, r["read"])
                cut_write = min(offset - cut_read, r["w5"] + r["w1h"])
                p = RATES[priced_as(r["model"])]
                t["after"] += cut_read * p["cacheRead"] + cut_write * (p["cacheWrite"] if ttl1h else p["input"] * 1.25)
            gap = ((nxt["ts"] if nxt else end) - r["ts"]).total_seconds()
            size = ctx(r) - offset
            if gap <= IDLE or size <= x or family(r["model"]) not in ("opus", "fable"):
                continue
            p = RATES[priced_as(r["model"])]
            read_price = p["cacheRead"] if ttl1h else p["input"] * 1.25
            small = min(compacted, size)
            fee = size * read_price + summary * p["output"] + small * p["cacheWrite"]
            t["compactions"] += 1
            t["fee"] += fee
            if nxt is None:
                t["wasted"] += 1
                t["wasted_fee"] += fee
                continue
            # The resume: observed, it rewrote (or read) the full context. Simulated, it reads the compacted context if
            # the resume came within an hour of the compaction, or rewrites it otherwise, plus the same new tokens.
            delta = max(ctx(nxt) - ctx(r), 0)
            write_price = p["cacheWrite"] if ttl1h else p["input"] * 1.25
            q = RATES[priced_as(nxt["model"])]
            observed_resume = cost(nxt) - nxt["out"] * q["output"]
            if gap <= IDLE + TTL_1H and ttl1h:
                sim_resume = small * p["cacheRead"] + delta * write_price
            else:
                sim_resume = (small + delta) * write_price
            t["resume"] += observed_resume - sim_resume
            t["resumes"] += 1
            resumed.add((f, i + 1))
            offset, since = size - small + offset, 0
    net = t["resume"] + t["after"] - t["fee"]
    return {"x": x, "horizon": horizon, "compactions": t["compactions"], "resumes": t["resumes"], "wasted": t["wasted"],
            "fee": t["fee"], "wastedFee": t["wasted_fee"], "resumeSaving": t["resume"], "afterSaving": t["after"], "net": net}

def keep_warm(by, hours, end):
    t = collections.Counter()
    most = int(hours * 3600 // IDLE)
    for (f, helper), reqs in by.items():
        if helper or sum(r["w1h"] for r in reqs) < sum(r["w5"] for r in reqs):
            continue
        for i, r in enumerate(reqs):
            nxt = reqs[i + 1] if i + 1 < len(reqs) else None
            gap = ((nxt["ts"] if nxt else end) - r["ts"]).total_seconds()
            if gap <= TTL_1H:
                continue
            p = RATES[priced_as(r["model"])]
            pings = min(int(gap // IDLE), most)
            t["pings"] += pings
            t["fee"] += pings * (ctx(r) * p["cacheRead"] + PING_OUT * p["output"])
            if nxt and gap <= most * IDLE + TTL_1H:
                q = RATES[priced_as(nxt["model"])]
                observed = cost(nxt) - nxt["out"] * q["output"]
                kept = ctx(r) * q["cacheRead"] + max(ctx(nxt) - ctx(r), 0) * q["cacheWrite"]
                t["saving"] += max(observed - kept, 0)
                t["avoided"] += 1
    return {"hours": hours, "pings": t["pings"], "avoided": t["avoided"], "fee": t["fee"], "saving": t["saving"],
            "net": t["saving"] - t["fee"]}

def gaps_report(by, end):
    g = collections.Counter()
    for (f, helper), reqs in by.items():
        for i, r in enumerate(reqs):
            nxt = reqs[i + 1] if i + 1 < len(reqs) else None
            gap = ((nxt["ts"] if nxt else end) - r["ts"]).total_seconds()
            if gap > IDLE:
                g[("helper" if helper else "main", "end" if nxt is None else "resume")] += 1
    return {f"{a} {b}": v for (a, b), v in g.items()}

def main():
    a = argparse.ArgumentParser()
    a.add_argument("--since", default="2026-09-01"); a.add_argument("--until", default="2026-10-18")
    a.add_argument("--deleted", action="store_true", help="add the T3 Code scan rows of deleted transcripts")
    a.add_argument("--json")
    o = a.parse_args()
    since = datetime.datetime.fromisoformat(o.since).replace(tzinfo=datetime.timezone.utc)
    end = datetime.datetime.fromisoformat(o.until).replace(tzinfo=datetime.timezone.utc)
    rs = [r for r in claude(since) if r["ts"] < end]
    if o.deleted:
        rs += [r for r in deleted_claude(since, {r["id"] for r in rs}) if r["ts"] < end]
    by = sessions(rs)
    post = [ctx(reqs[i]) for (f, h), reqs in by.items() if not h for i in compactions(reqs)]
    compacted = statistics.median(post) if post else 30_000
    summary, n_summaries = summary_tokens({f for f, _ in by})
    result = {
        "requests": len(rs), "sessions": sum(not h for _, h in by), "claudeCodeUsd": sum(cost(r) for r in rs),
        "observedCompactions": len(post), "compactedTokens": compacted, "summaryTokens": summary, "summaries": n_summaries,
        "gaps": gaps_report(by, end),
        "sweep": [simulate(by, x, compacted, summary, end, h) for h in (None, 20, 0) for x in SWEEP],
        "keepWarm": [keep_warm(by, h, end) for h in HOURS],
    }
    print(json.dumps(result, indent=1, default=float))
    if o.json:
        json.dump(result, open(o.json, "w"), indent=1, default=float)

if __name__ == "__main__":
    main()
