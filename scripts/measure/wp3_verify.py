# WP3 discrimination test: a verifier that reads only the task and the final answer, compared with
# the blind judge's good-enough verdicts on answers that already exist.
#   python3 -I scripts/measure/wp3_verify.py OUT --pairs DIR KEY JUDGE --paired TASKS RUNS_DIR [--only-kind read-only]
# --pairs reads an earlier blind test (pair-N.md with "# Task", "# Answer A", "# Answer B", its key and judge list).
# --paired reads a paired.py run directory (runs.jsonl, blind.key.json, judge.json).
import argparse, concurrent.futures as cf, json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paired import bb, price_thread, wait_turn

VERIFIER = """You check one answer from a coding agent before the person sees it. You see only the task and the final answer.
Question: can an engineer act on this answer without asking again, and does the answer cite the evidence it rests on (files, logs, commands, links, or tool results it actually read)?
Say no when the answer guesses a cause it did not check, hedges where a check was possible, or gives a conclusion without evidence.
Do not use any tools. Reply with only one JSON object:
{"ok": true|false, "reason": "<one sentence naming the missing evidence, if any>"}

"""

def from_pairs(directory, key_path, judge_path):
    key, judge = json.load(open(key_path)), {str(j["pair"]): j for j in json.load(open(judge_path))}
    items = []
    for f in sorted(os.listdir(directory)):
        n = re.search(r"(\d+)", f).group(1)
        text = open(f"{directory}/{f}").read()
        task = text.split("# Answer A")[0].replace("# Task", "").strip()
        a, b = text.split("# Answer A", 1)[1].split("# Answer B", 1)
        for label, answer in zip("AB", (a, b)):
            arm = key[n]["AB".index(label)]
            items.append({"id": f"earlier-{n}-{arm}", "task": task, "answer": answer.strip(), "arm": arm,
                          "judge": judge[n][f"goodEnough{label}"]})
    return items

def from_paired(tasks_path, out, kind):
    doc = json.load(open(tasks_path))
    runs = {(r["task"], r["arm"]): r for r in map(json.loads, open(f"{out}/runs.jsonl"))}
    key, verdicts = json.load(open(f"{out}/blind.key.json")), json.load(open(f"{out}/judge.json"))["verdicts"]
    items = []
    for t in doc["tasks"]:
        if (kind and t["kind"] != kind) or t["id"] not in verdicts:
            continue
        for label, arm in zip("AB", key[t["id"]]):
            r = runs[(t["id"], arm)]
            items.append({"id": f"baseline-{t['id']}-{arm}", "task": "\n\n".join(t["messages"]), "answer": r["turns"][-1],
                          "arm": arm, "judge": verdicts[t["id"]][label], "usd": r["price"]["usd"]})
    return items

def verify(item, project, environment):
    t = json.loads(bb("thread", "spawn", "--json", "--parent-self", "--project", project, "--environment", environment,
                      "--provider", "claude-code", "--model", "claude-opus-5-5", "--reasoning-level", "low",
                      "--title", f"measure verifier {item['id']}", "--prompt-file", "-",
                      stdin=f"{VERIFIER}# Task\n\n{item['task']}\n\n# Answer\n\n{item['answer']}"))["id"]
    if wait_turn(t, 0) != "done":
        raise RuntimeError(f"verifier thread {t} did not finish")
    text = json.loads(bb("thread", "output", t, "--json")).get("output") or ""
    verdict = json.loads(text[text.index("{"): text.rindex("}") + 1])
    return {**item, "verifier": verdict, "thread": t, "verifierUsd": price_thread(t)["usd"]}

def main():
    a = argparse.ArgumentParser()
    a.add_argument("out")
    a.add_argument("--pairs", nargs=3)
    a.add_argument("--paired", nargs=2)
    a.add_argument("--only-kind", default="read-only")
    a.add_argument("--project", default="proj_hymem4rej5")
    a.add_argument("--environment", default="env_izxivbi46y")
    o = a.parse_args()
    items = (from_pairs(*o.pairs) if o.pairs else []) + (from_paired(*o.paired, o.only_kind) if o.paired else [])
    done = {r["id"]: r for r in map(json.loads, open(o.out))} if os.path.exists(o.out) else {}
    with cf.ThreadPoolExecutor(6) as ex, open(o.out, "a") as f:
        for r in ex.map(lambda i: verify(i, o.project, o.environment), [i for i in items if i["id"] not in done]):
            f.write(json.dumps(r) + "\n"); f.flush()
            done[r["id"]] = r
            print(f"{r['id']:24} judge {'yes' if r['judge'] else 'no ':3} verifier {'yes' if r['verifier']['ok'] else 'no '} ${r['verifierUsd']:.3f}", flush=True)
    rs = [done[i["id"]] for i in items]
    flagged_bad = [r["id"] for r in rs if not r["judge"] and not r["verifier"]["ok"]]
    missed_bad = [r["id"] for r in rs if not r["judge"] and r["verifier"]["ok"]]
    flagged_good = [r["id"] for r in rs if r["judge"] and not r["verifier"]["ok"]]
    cost = sum(r["verifierUsd"] for r in rs)
    print(f"\n{len(rs)} answers, verifier ${cost:.2f} in total, ${cost / len(rs):.3f} per call")
    print(f"not good enough per judge, flagged: {flagged_bad}")
    print(f"not good enough per judge, passed: {missed_bad}")
    print(f"good enough per judge, flagged: {flagged_good}")

if __name__ == "__main__":
    main()
