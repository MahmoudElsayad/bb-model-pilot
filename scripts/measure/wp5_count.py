# Counts Model Pilot's plan and helper decisions with the vote share behind each, and how many a
# higher share threshold would turn into "the main agent does it".
#   python3 -I scripts/measure/wp5_count.py [--threshold 0.65] [ROUTES.jsonl ...]
# Live decisions come from `bb auto status` of every Model Pilot thread, replayed ones from route files.
import argparse, collections, concurrent.futures as cf, json, subprocess

def bb(*args):
    p = subprocess.run(["bb", *args], capture_output=True, text=True, timeout=300)
    return json.loads(p.stdout) if p.returncode == 0 else None

def live():
    threads = []
    for proj in bb("project", "list", "--json"):
        for flags in ([], ["--archived"]):
            threads += bb("thread", "list", "--project", proj["id"], "--include-hidden", *flags, "--json") or []
    auto = {t["id"]: t for t in threads if t.get("providerId") == "auto"}
    def decisions(tid):
        s = bb("auto", "status", "--thread", tid) or {}
        return [(tid, h["entry"]) for h in s.get("history") or [] if h["entry"].get("type") == "route"
                and h["entry"].get("scope") == "main" and h["entry"].get("delegation")]
    with cf.ThreadPoolExecutor(8) as ex:
        return [d for ds in ex.map(decisions, auto) for d in ds], auto

def shape(d):
    return "plan" if d.get("plan") else "helper" if d.get("delegate") else "main"

def table(name, delegations, threshold):
    c = collections.Counter(shape(d) for d in delegations)
    low = collections.Counter(shape(d) for d in delegations if shape(d) != "main" and d["share"] < threshold - 1e-9)
    shares = {s: sorted(round(d["share"], 2) for d in delegations if shape(d) == s) for s in ("plan", "helper")}
    print(f"\n{name}: {len(delegations)} decisions, main {c['main']}, plan {c['plan']}, helper {c['helper']}")
    for s in ("plan", "helper"):
        print(f"  {s}: {c[s]} decisions, {low[s]} below {threshold} would go to the main agent; shares {shares[s]}")
    return {"n": len(delegations), "counts": dict(c), "below": dict(low), "shares": shares}

def main():
    a = argparse.ArgumentParser()
    a.add_argument("routes", nargs="*")
    a.add_argument("--threshold", type=float, default=0.65)
    a.add_argument("--json")
    o = a.parse_args()
    out = {}
    ds, auto = live()
    out["live"] = table(f"Live threads ({len(auto)} Model Pilot threads)", [e["delegation"] for _, e in ds], o.threshold)
    out["liveFirst"] = table("Live, first prompts", [e["delegation"] for _, e in ds if e.get("isFirstPrompt")], o.threshold)
    out["liveLater"] = table("Live, later messages", [e["delegation"] for _, e in ds if not e.get("isFirstPrompt")], o.threshold)
    for f in o.routes:
        rs = [json.loads(l) for l in open(f)]
        out[f] = table(f"Replay {f}", [r["delegation"] for r in rs if r.get("delegation")], o.threshold)
    if o.json:
        json.dump(out, open(o.json, "w"), indent=1)

if __name__ == "__main__":
    main()
