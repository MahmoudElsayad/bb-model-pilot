# Runs a frozen task set on several arms at the same time, prices every thread from its transcripts,
# writes blind pairs, and asks a separate judge thread for verdicts.
#   python3 -I scripts/measure/paired.py run    TASKS ARMS OUT [--only id,id] [--budget 30] [--parallel 3]
#   python3 -I scripts/measure/paired.py adopt  TASKS ARMS OUT TASK ARM THREAD
#   python3 -I scripts/measure/paired.py price  OUT
#   python3 -I scripts/measure/paired.py blind  TASKS OUT ARM_A ARM_B
#   python3 -I scripts/measure/paired.py judge  OUT
#   python3 -I scripts/measure/paired.py report TASKS OUT ARM_A ARM_B
# TASKS: {"rule": str, "tasks": [{"id", "kind", "project", "environment" | "newEnvironment", "messages": [str]}]}
# ARMS:  {"name": ["bb thread spawn flags", ...]}
import argparse, collections, concurrent.futures as cf, datetime, glob, json, os, random, re, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prices import priced_as, usd
from sources import CLAUDE, CODEX, claude, codex

EPOCH = datetime.datetime(2000, 1, 1, tzinfo=datetime.timezone.utc)
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

def bb(*args, stdin=None, timeout=3700, as_user=False):
    """as_user drops BB_THREAD_ID, so BB delivers a message as the user's and not as one from this thread."""
    env = {k: v for k, v in os.environ.items() if k != "BB_THREAD_ID"} if as_user else None
    p = subprocess.run(["bb", *args], input=stdin, capture_output=True, text=True, timeout=timeout, env=env)
    if p.returncode:
        raise RuntimeError(f"bb {' '.join(args[:3])}: {p.stderr.strip()[-400:]}")
    return p.stdout

def completed_turns(thread):
    return sum(e["type"] == "turn/completed" for e in json.loads(bb("thread", "log", thread, "--all", "--json")))

def wait_turn(thread, before, timeout_s=1800):
    """Waits until the thread finished one more turn than `before`. Returns "done", "error" or "timeout"."""
    end = time.time() + timeout_s
    while time.time() < end:
        status = json.loads(bb("thread", "show", thread, "--json"))["thread"]["status"]
        if status == "error":
            return "error"
        if status == "idle" and completed_turns(thread) > before:
            return "done"
        time.sleep(10)
    return "timeout"

def run_arm(task, rule, arm, flags, thread=None, turns=None):
    """Runs one task on one arm. With `thread`, continues that thread after the turns it already finished."""
    started = time.time()
    msgs = [m + rule if task["kind"] != "edit" else m for m in task["messages"]]
    where = ["--environment", task["environment"]] if task.get("environment") else ["--new-environment", task["newEnvironment"]]
    if thread is None:
        thread = json.loads(bb("thread", "spawn", "--json", "--parent-self", "--project", task["project"], *where, *flags,
                               "--title", f"measure {task['id']} {arm}", "--prompt-file", "-", stdin=msgs[0]))["id"]
    turns, state = list(turns or []), "done"
    for i, m in enumerate(msgs):
        if i < len(turns):
            continue
        if i and completed_turns(thread) <= i:
            bb("thread", "tell", thread, "--message-file", "-", stdin=m, as_user=True)
        state = wait_turn(thread, i)
        turns.append(json.loads(bb("thread", "output", thread, "--json")).get("output") or "")
        if state != "done":
            bb("thread", "stop", thread)
            break
    return {"task": task["id"], "arm": arm, "thread": thread, "turns": turns, "finished": state == "done", "state": state,
            "minutes": round((time.time() - started) / 60, 1)}

def thread_tree(thread):
    """The thread and every helper. Background helpers are child threads. Model Pilot's other helpers are hidden,
    archived threads with no parent, so they are found by their lifecycle owner."""
    root = json.loads(bb("thread", "show", thread, "--json"))["thread"]
    hidden = []
    for flags in ([], ["--archived"]):
        hidden += json.loads(bb("thread", "list", "--project", root["projectId"], "--include-hidden", *flags, "--json"))
    candidates = {t["id"] for t in hidden if (t.get("title") or "").startswith("Auto helper") and t["createdAt"] >= root["createdAt"]}
    owner = {c: json.loads(bb("thread", "show", c, "--json"))["thread"]["lifecycleOwnerThreadId"] for c in candidates}
    out, todo = [], [thread]
    while todo:
        t = todo.pop()
        if t in out:
            continue
        out.append(t)
        todo += [c for c, o in owner.items() if o == t]
        for flags in ([], ["--archived"]):
            todo += [c["id"] for c in json.loads(bb("thread", "list", "--parent-thread", t, "--include-hidden", *flags, "--json"))]
    return out

def session_ids(thread):
    log = bb("thread", "log", thread, "--all", "--json")
    return set(re.findall(rf'"(?:session_id|providerSessionId|providerThreadId)":\s*"({UUID})"', log))

def transcripts(ids):
    files = []
    for i in ids:
        for root in CLAUDE:
            for f in glob.glob(f"{root}/*/{i}.jsonl"):
                files += [f, *glob.glob(f"{f[:-6]}/subagents/*.jsonl")]
        for root in CODEX:
            files += glob.glob(f"{root}/**/*{i}.jsonl", recursive=True)
    return sorted(set(files))

def classifier_usd(thread):
    try:
        return json.loads(bb("auto", "status", "--thread", thread))["usage"]["jev"]["usd"]
    except (RuntimeError, KeyError, TypeError, ValueError):
        return 0.0

def stop_children(thread):
    """Helpers can wait on a permission prompt that nobody answers. Stop them once the parent is done."""
    for t in thread_tree(thread)[1:]:
        if json.loads(bb("thread", "show", t, "--json"))["thread"]["status"] != "idle":
            bb("thread", "stop", t)

def price_thread(thread):
    tree = thread_tree(thread)
    main = {f for f in transcripts(session_ids(thread)) if "/subagents/" not in f}
    files = transcripts(set().union(*(session_ids(t) for t in tree)))
    cfiles = [f for f in files if "/.claude/" in f]
    xfiles = [f for f in files if "/.codex/" in f]
    rs = (claude(EPOCH, paths=cfiles) if cfiles else []) + (codex(EPOCH, paths=xfiles) if xfiles else [])
    cats, models, unpriced = collections.Counter(), collections.Counter(), 0
    for r in rs:
        c = usd(r)
        if c is None:
            unpriced += 1
            continue
        cats.update(c)
        models[priced_as(r["model"]) + ("" if r["file"] in main else " helper")] += sum(c.values())
    jev = sum(classifier_usd(t) for t in tree)
    return {"threads": tree, "files": len(files), "requests": len(rs), "unpriced": unpriced,
            "categories": dict(cats), "byModel": dict(models), "classifier": jev, "usd": sum(cats.values()) + jev}

def cmd_run(o):
    doc, arms = json.load(open(o.tasks)), json.load(open(o.arms))
    os.makedirs(o.out, exist_ok=True)
    path = f"{o.out}/runs.jsonl"
    done = {(r["task"], r["arm"]) for r in map(json.loads, open(path))} if os.path.exists(path) else set()
    only = set(o.only.split(",")) if o.only else None
    todo = [t for t in doc["tasks"] if (not only or t["id"] in only) and any((t["id"], a) not in done for a in arms)]
    spent = sum(r["price"]["usd"] for r in map(json.loads, open(path))) if os.path.exists(path) else 0.0
    for i in range(0, len(todo), o.parallel):
        if spent > o.budget:
            print(f"stop: ${spent:.2f} spent, budget ${o.budget}", flush=True)
            break
        with cf.ThreadPoolExecutor(o.parallel * len(arms)) as ex:
            futures = [ex.submit(run_arm, t, doc["rule"], a, f) for t in todo[i:i + o.parallel]
                       for a, f in arms.items() if (t["id"], a) not in done]
            for fut in cf.as_completed(futures):
                r = fut.result()
                stop_children(r["thread"])
                r["price"] = price_thread(r["thread"])
                spent += r["price"]["usd"]
                # A failed run is kept apart and the task runs again next time, so a network outage does not count as an answer.
                open(path if r["finished"] else f"{o.out}/failed.jsonl", "a").write(json.dumps(r) + "\n")
                print(f"{r['task']:7} {r['arm']:6} ${r['price']['usd']:.2f} {r['minutes']}m finished={r['finished']} | spent ${spent:.2f}", flush=True)

def cmd_adopt(o):
    """Finishes a run whose runner stopped: o.thread is the arm's existing thread."""
    doc, arms = json.load(open(o.tasks)), json.load(open(o.arms))
    task = next(t for t in doc["tasks"] if t["id"] == o.task)
    old = [r for r in map(json.loads, open(f"{o.out}/failed.jsonl"))] if os.path.exists(f"{o.out}/failed.jsonl") else []
    prev = next((r for r in old if r["thread"] == o.thread), None)
    done_turns = []
    if prev:
        done_turns = prev["turns"][:min(len(prev["turns"]), completed_turns(o.thread))]
    r = run_arm(task, doc["rule"], o.arm, arms[o.arm], thread=o.thread, turns=done_turns)
    stop_children(r["thread"])
    r["price"] = price_thread(r["thread"])
    r["adopted"] = True
    open(f"{o.out}/runs.jsonl" if r["finished"] else f"{o.out}/failed.jsonl", "a").write(json.dumps(r) + "\n")
    print(f"{r['task']:7} {r['arm']:6} ${r['price']['usd']:.2f} finished={r['finished']} (adopted {o.thread})", flush=True)

def cmd_price(o):
    path = f"{o.out}/runs.jsonl"
    rs = [json.loads(l) for l in open(path)]
    for r in rs:
        r["price"] = price_thread(r["thread"])
        print(f"{r['task']:7} {r['arm']:6} ${r['price']['usd']:.2f} files={r['price']['files']}", flush=True)
    open(path, "w").write("".join(json.dumps(r) + "\n" for r in rs))

def runs(out):
    return {(r["task"], r["arm"]): r for r in map(json.loads, open(f"{out}/runs.jsonl"))}

def cmd_blind(o):
    doc, R = json.load(open(o.tasks)), runs(o.out)
    rng, key = random.Random(4242), {}
    os.makedirs(f"{o.out}/blind", exist_ok=True)
    for t in doc["tasks"]:
        if (t["id"], o.a) not in R or (t["id"], o.b) not in R:
            continue
        sides = [o.a, o.b]
        rng.shuffle(sides)
        key[t["id"]] = sides
        text = [f"# Task {t['id']}\n"]
        for i, m in enumerate(t["messages"]):
            text.append(f"\n## User message {i + 1}\n\n{m}\n")
            for label, arm in zip("AB", sides):
                turns = R[(t["id"], arm)]["turns"]
                text.append(f"\n### Answer {label}, turn {i + 1}\n\n{turns[i] if i < len(turns) else '(no answer)'}\n")
        open(f"{o.out}/blind/{t['id']}.md", "w").write("".join(text))
    json.dump(key, open(f"{o.out}/blind.key.json", "w"))
    print(f"{len(key)} pairs in {o.out}/blind")

JUDGE = """You judge two answers from two coding agents to the same task. You do not know which agent wrote which answer.
The task below holds the user's messages and, for each message, Answer A and Answer B.
For each answer, decide if an engineer can act on it without asking again ("good enough"), judging from the evidence it cites.
Judge a multi-turn task by its final state after all turns.
Then pick the better answer, or call a tie if the extra detail does not help.
Do not use any tools. Reply with only one JSON object:
{"A": true|false, "B": true|false, "better": "A"|"B"|"tie", "reason": "<one sentence>"}

"""

def judge_one(o, task, pair):
    t = json.loads(bb("thread", "spawn", "--json", "--parent-self", "--project", o.project, "--environment", o.environment,
                      "--provider", "claude-code", "--model", "claude-opus-5-5", "--reasoning-level", "medium",
                      "--title", f"measure judge {task}", "--prompt-file", "-", stdin=JUDGE + pair))["id"]
    if wait_turn(t, 0) != "done":
        raise RuntimeError(f"judge thread {t} did not finish")
    text = json.loads(bb("thread", "output", t, "--json")).get("output") or ""
    return task, {"thread": t, **json.loads(text[text.index("{"): text.rindex("}") + 1])}

def cmd_judge(o):
    pairs = {f[:-3]: open(f"{o.out}/blind/{f}").read() for f in sorted(os.listdir(f"{o.out}/blind"))}
    path = f"{o.out}/judge.json"
    verdicts = json.load(open(path))["verdicts"] if os.path.exists(path) else {}
    with cf.ThreadPoolExecutor(4) as ex:
        for task, v in ex.map(lambda kv: judge_one(o, *kv), [(k, p) for k, p in pairs.items() if k not in verdicts]):
            verdicts[task] = v
            json.dump({"verdicts": verdicts}, open(path, "w"), indent=1)
            print(task, v["A"], v["B"], v["better"], flush=True)

def cmd_report(o):
    doc, R = json.load(open(o.tasks)), runs(o.out)
    key = json.load(open(f"{o.out}/blind.key.json"))
    V = json.load(open(f"{o.out}/judge.json"))["verdicts"] if os.path.exists(f"{o.out}/judge.json") else {}
    tot = {o.a: collections.Counter(), o.b: collections.Counter()}
    print(f"| Task | {o.a} | {o.b} | {o.a} good | {o.b} good | Better |\n| --- | --- | --- | --- | --- | --- |")
    for t in doc["tasks"]:
        if t["id"] not in key:
            continue
        v = V.get(t["id"], {})
        good = {arm: v.get(label) for label, arm in zip("AB", key[t["id"]])}
        better = {"A": key[t["id"]][0], "B": key[t["id"]][1]}.get(v.get("better"), v.get("better"))
        for arm in (o.a, o.b):
            p = R[(t["id"], arm)]["price"]
            tot[arm]["usd"] += p["usd"]; tot[arm]["good"] += bool(good[arm]); tot[arm]["n"] += 1
            tot[arm].update({k: p["categories"].get(k, 0) for k in ("write", "read", "new", "out")})
        print(f"| {t['id']} | ${R[(t['id'], o.a)]['price']['usd']:.2f} | ${R[(t['id'], o.b)]['price']['usd']:.2f} | "
              f"{'yes' if good[o.a] else 'no'} | {'yes' if good[o.b] else 'no'} | {better or '?'} |")
    for arm, c in tot.items():
        per = c["usd"] / c["good"] if c["good"] else float("inf")
        print(f"{arm}: ${c['usd']:.2f} on {c['n']} tasks, {c['good']} good enough, ${per:.2f} per good-enough answer; "
              f"write ${c['write']:.2f} read ${c['read']:.2f} uncached ${c['new']:.2f} output ${c['out']:.2f}")

def main():
    a = argparse.ArgumentParser()
    s = a.add_subparsers(dest="cmd", required=True)
    p = s.add_parser("run"); p.add_argument("tasks"); p.add_argument("arms"); p.add_argument("out")
    p.add_argument("--only"); p.add_argument("--budget", type=float, default=30); p.add_argument("--parallel", type=int, default=3)
    p = s.add_parser("price"); p.add_argument("out")
    p = s.add_parser("adopt"); p.add_argument("tasks"); p.add_argument("arms"); p.add_argument("out")
    p.add_argument("task"); p.add_argument("arm"); p.add_argument("thread")
    for n in ("blind", "report"):
        p = s.add_parser(n); p.add_argument("tasks"); p.add_argument("out"); p.add_argument("a"); p.add_argument("b")
    p = s.add_parser("judge"); p.add_argument("out")
    p.add_argument("--project", default="proj_hymem4rej5"); p.add_argument("--environment", default="env_izxivbi46y")
    o = a.parse_args()
    {"run": cmd_run, "adopt": cmd_adopt, "price": cmd_price, "blind": cmd_blind, "judge": cmd_judge, "report": cmd_report}[o.cmd](o)

if __name__ == "__main__":
    main()
