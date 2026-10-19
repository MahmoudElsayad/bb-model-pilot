# WP1 quality test: forks an idle thread twice, compacts one fork, sends both the same follow-up,
# prices the new requests of each fork from its transcripts, and asks a blind judge per pair.
#   python3 -I scripts/measure/wp1_forks.py run   CASES OUT
#   python3 -I scripts/measure/wp1_forks.py adopt CASES OUT ID FULL COMPACTED
#   python3 -I scripts/measure/wp1_forks.py judge CASES OUT
#   python3 -I scripts/measure/wp1_forks.py report OUT
# CASES: [{"id", "thread", "followUp", "excerpt"}]. `excerpt` is the early conversation the follow-up
# depends on, so the judge can check facts. Keep CASES and OUT outside the repo: they hold private text.
import argparse, collections, concurrent.futures as cf, datetime, json, os, random, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paired import JUDGE, bb, completed_turns, judge_one, session_ids, transcripts, wait_turn
from prices import RATES, priced_as, usd
from sources import claude

def events(thread):
    return json.loads(bb("thread", "log", thread, "--all", "--json"))

def wait_compacted(thread, timeout_s=1800):
    """Compacts the thread and waits until it logged the compaction and is idle again. BB drops a
    compact request that reaches a fork while it is still starting, so the request is sent again
    until a compaction item starts."""
    end = time.time() + timeout_s
    for _ in range(10):
        if json.loads(bb("thread", "show", thread, "--json"))["thread"]["status"] == "idle":
            bb("thread", "compact", thread)
        time.sleep(30)
        if any(e["type"] == "item/started" and e["data"].get("item", {}).get("type") == "contextCompaction"
               for e in events(thread)):
            break
    while time.time() < end:
        status = json.loads(bb("thread", "show", thread, "--json"))["thread"]["status"]
        if status == "error":
            return "error"
        if status == "idle" and any(e["type"] == "thread/compacted" for e in events(thread)):
            return "done"
        time.sleep(10)
    return "timeout"

def fork(source, title):
    owner = ["--lifecycle-owner-thread", os.environ["BB_THREAD_ID"]] if os.environ.get("BB_THREAD_ID") else []
    return json.loads(bb("thread", "fork", source, "--json", "--title", title, *owner))["id"]

def price(thread, since, split):
    """The fork's requests after `since`, as compaction (before `split`) and follow-up (after it)."""
    files = [f for f in transcripts(session_ids(thread)) if "/.claude/" in f]
    out = {"compaction": collections.Counter(), "followUp": collections.Counter(), "requests": 0, "models": set()}
    for r in claude(since, paths=files) if files else []:
        c = usd(r)
        if c is None:
            continue
        out["compaction" if r["ts"] < split else "followUp"].update(c)
        out["requests"] += 1
        out["models"].add(priced_as(r["model"]))
    return {"compaction": dict(out["compaction"]), "followUp": dict(out["followUp"]), "requests": out["requests"],
            "models": sorted(out["models"]), "files": len(files)}

def run_case(case, full=None, compact=None):
    """With `full` and `compact`, finishes forks that a stopped runner made."""
    started = datetime.datetime.now(datetime.timezone.utc)
    if full is None:
        full = fork(case["thread"], f"measure wp1 {case['id']} full")
        compact = fork(case["thread"], f"measure wp1 {case['id']} compacted")
    else:
        created = json.loads(bb("thread", "show", full, "--json"))["thread"]["createdAt"]
        started = datetime.datetime.fromtimestamp(created / 1000, datetime.timezone.utc)
    compacted = any(e["type"] == "item/completed" and e["data"].get("item", {}).get("type") == "contextCompaction"
                    for e in events(compact))
    state = "done" if compacted and json.loads(bb("thread", "show", compact, "--json"))["thread"]["status"] == "idle" \
        else wait_compacted(compact)
    split = datetime.datetime.now(datetime.timezone.utc)
    result = {"id": case["id"], "source": case["thread"], "full": full, "compacted": compact, "compactState": state}
    if state != "done":
        for t in (full, compact):
            bb("thread", "stop", t)
        return result
    arms = {}
    for name, t in (("full", full), ("compacted", compact)):
        before = completed_turns(t)
        bb("thread", "tell", t, "--message-file", "-", stdin=case["followUp"], as_user=True)
        arms[name] = (t, before)
    for name, (t, before) in arms.items():
        result[f"{name}State"] = wait_turn(t, before)
        result[f"{name}Answer"] = json.loads(bb("thread", "output", t, "--json")).get("output") or ""
    time.sleep(20)  # let the transcripts flush
    for name, (t, _) in arms.items():
        result[f"{name}Price"] = price(t, started, split)
        bb("thread", "stop", t)
    return result

def cmd_run(o):
    cases = json.load(open(o.cases))
    os.makedirs(o.out, exist_ok=True)
    path = f"{o.out}/runs.jsonl"
    done = {json.loads(l)["id"] for l in open(path)} if os.path.exists(path) else set()
    with cf.ThreadPoolExecutor(4) as ex:
        for r in ex.map(run_case, [c for c in cases if c["id"] not in done]):
            open(path, "a").write(json.dumps(r) + "\n")
            cost = {a: sum(r.get(f"{a}Price", {}).get(k, {}).get(c, 0) for k in ("compaction", "followUp")
                           for c in ("write", "read", "new", "out")) for a in ("full", "compacted")}
            print(r["id"], r["compactState"], {a: f"${v:.2f}" for a, v in cost.items()}, flush=True)

def compaction(thread):
    """The compaction as Claude Code logged it: context before and after, and the summary size.
    Claude Code logs no usage for the summary request itself, so the report prices it."""
    for f in transcripts(session_ids(thread)):
        lines = [json.loads(l) for l in open(f, errors="ignore")]
        for i, e in enumerate(lines):
            if e.get("subtype") == "compact_boundary":
                summary = next((x for x in lines[i - 2:i + 3] if x.get("isCompactSummary")), {})
                chars = len(json.dumps((summary.get("message") or {}).get("content") or ""))
                meta = e["compactMetadata"]
                return {"pre": meta["preTokens"], "post": meta["postTokens"], "summaryTokens": chars // 4}
    return None

def cmd_report(o):
    """Prices each compaction two ways: warm, as the WP1 policy runs it before the cache expires (a
    cache read of the context), and cold, as in this test, where the source sat idle for hours."""
    rs = [json.loads(l) for l in open(f"{o.out}/runs.jsonl")]
    V = json.load(open(f"{o.out}/judge.json"))["verdicts"] if os.path.exists(f"{o.out}/judge.json") else {}
    print("| Case | Context | Compacted to | Full good | Compacted good | Better | Full follow-up | Compacted follow-up | Compaction warm | Compaction cold |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    tot = collections.Counter()
    for r in rs:
        if r["compactState"] != "done":
            continue
        c = compaction(r["compacted"])
        model = r["compactedPrice"]["models"][0]
        rate = RATES[priced_as(model)]
        warm = c["pre"] * rate["cacheRead"] + c["summaryTokens"] * rate["output"]
        cold = c["pre"] * rate["cacheWrite"] + c["summaryTokens"] * rate["output"]
        full = sum(r["fullPrice"]["followUp"].values())
        comp = sum(r["compactedPrice"]["followUp"].values())
        tot.update({"full": full, "compacted": comp, "warm": warm, "cold": cold})
        v = V.get(r["id"], {})
        yn = lambda x: "?" if x is None else "yes" if x else "no"
        print(f"| {r['id']} | {c['pre'] // 1000}k | {c['post'] // 1000}k | {yn(v.get('full'))} | {yn(v.get('compacted'))} | "
              f"{v.get('betterArm', '?')} | ${full:.2f} | ${comp:.2f} | ${warm:.2f} | ${cold:.2f} |")
    print(f"Totals: full follow-ups ${tot['full']:.2f}, compacted follow-ups ${tot['compacted']:.2f}, "
          f"compactions ${tot['warm']:.2f} warm or ${tot['cold']:.2f} cold.")

def cmd_adopt(o):
    case = next(c for c in json.load(open(o.cases)) if c["id"] == o.id)
    r = run_case(case, o.full, o.compacted)
    r["adopted"] = True
    open(f"{o.out}/runs.jsonl", "a").write(json.dumps(r) + "\n")
    print(r["id"], r["compactState"], flush=True)

def cmd_judge(o):
    cases = {c["id"]: c for c in json.load(open(o.cases))}
    rs = {r["id"]: r for r in map(json.loads, open(f"{o.out}/runs.jsonl")) if r["compactState"] == "done"}
    rng, key, pairs = random.Random(4242), {}, {}
    for i, r in rs.items():
        sides = ["full", "compacted"]
        rng.shuffle(sides)
        key[i] = sides
        pairs[i] = (f"# Task {i}\n\nEarlier in the conversation (for checking facts):\n\n{cases[i]['excerpt']}\n\n"
                    f"## User message 1\n\n{cases[i]['followUp']}\n\n"
                    + "".join(f"### Answer {label}, turn 1\n\n{r[f'{arm}Answer']}\n\n" for label, arm in zip("AB", sides)))
    json.dump(key, open(f"{o.out}/blind.key.json", "w"))
    j = argparse.Namespace(project=o.project, environment=o.environment)
    verdicts = {}
    with cf.ThreadPoolExecutor(4) as ex:
        for task, v in ex.map(lambda kv: judge_one(j, *kv), pairs.items()):
            verdicts[task] = {**v, **{arm: v[label] for label, arm in zip("AB", key[task])},
                              "betterArm": dict(zip("AB", key[task])).get(v["better"], v["better"])}
            print(task, "full", verdicts[task]["full"], "compacted", verdicts[task]["compacted"], verdicts[task]["betterArm"], flush=True)
    json.dump({"verdicts": verdicts}, open(f"{o.out}/judge.json", "w"), indent=1)

def main():
    a = argparse.ArgumentParser()
    s = a.add_subparsers(dest="cmd", required=True)
    for n in ("run", "judge"):
        p = s.add_parser(n); p.add_argument("cases"); p.add_argument("out")
    p.add_argument("--project", default="proj_hymem4rej5"); p.add_argument("--environment", default="env_izxivbi46y")
    p = s.add_parser("report"); p.add_argument("out")
    p = s.add_parser("adopt"); p.add_argument("cases"); p.add_argument("out")
    p.add_argument("id"); p.add_argument("full"); p.add_argument("compacted")
    o = a.parse_args()
    {"run": cmd_run, "adopt": cmd_adopt, "judge": cmd_judge, "report": cmd_report}[o.cmd](o)

if __name__ == "__main__":
    main()
