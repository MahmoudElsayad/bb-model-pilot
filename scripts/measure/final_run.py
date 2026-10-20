# Runs the final waves unattended within Claude's subscription windows.
#   python3 -I scripts/measure/final_run.py TASKS OUT PLUGIN_REPO --wave ARMS [--wave ARMS@COMMIT ...]
# Before each wave it waits until the Claude five-hour window allows work. A wave whose runs fail, for
# example on an exhausted window or a lost network, pauses until the next window, sets aside the
# finished arms of each failed task so all of its arms run again at the same time, and runs those
# tasks again. ARMS@COMMIT first builds and reloads Model Pilot from COMMIT; after the last wave the
# plugin is rebuilt from the branch it started on.
import argparse, json, os, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paired import bb, wait_turn

HERE = os.path.dirname(os.path.abspath(__file__))

def log(message):
    print(time.strftime("%H:%M:%S"), message, flush=True)

def window():
    """The Claude window BB reports after one tiny turn: (status, resetsAtMs)."""
    t = json.loads(bb("thread", "spawn", "--json", "--parent-self", "--project", "proj_hymem4rej5",
                      "--environment", "env_izxivbi46y", "--provider", "claude-code",
                      "--model", "claude-haiku-4-5-20251001", "--reasoning-level", "low",
                      "--title", "measure window check", "--prompt-file", "-", stdin="Reply with the word ok. Use no tools."))["id"]
    state = wait_turn(t, 0, 600)
    events = json.loads(bb("thread", "log", t, "--all", "--json"))
    bb("thread", "stop", t)
    reports = [e["data"]["rateLimits"] for e in events if e["type"] == "provider/rateLimits/updated"]
    if state != "done" or not reports:
        return "blocked", None
    five = [w for w in reports[-1]["windows"] if w.get("providerKey") == "five_hour"] or reports[-1]["windows"]
    return reports[-1]["status"], max((w["resetsAtMs"] or 0) for w in five) or None

def wait_for_window(after_ms=0):
    """Waits until `after_ms` has passed and the window allows work."""
    while True:
        if time.time() * 1000 < after_ms:
            log(f"waiting for the window that resets at {time.strftime('%H:%M', time.localtime(after_ms / 1000))}")
            time.sleep(after_ms / 1000 - time.time() + 120)
        status, resets = window()
        log(f"window {status}, resets {time.strftime('%H:%M', time.localtime(resets / 1000)) if resets else '?'}")
        if status == "allowed":
            return resets
        after_ms = resets or time.time() * 1000 + 600_000

def install(repo, ref):
    subprocess.run(["git", "-C", repo, "checkout", "-q", ref], check=True)
    subprocess.run(["bb", "plugin", "build", repo], check=True, capture_output=True)
    subprocess.run(["bb", "plugin", "reload", "auto-router"], check=True, capture_output=True)
    log(f"Model Pilot built from {ref} ({subprocess.run(['git', '-C', repo, 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip()})")

def set_aside_failed(out):
    """Moves failures to failed-paused.jsonl and the finished arms of those tasks to superseded.jsonl."""
    path = f"{out}/failed.jsonl"
    if not os.path.exists(path):
        return set()
    failed = [json.loads(l) for l in open(path)]
    open(f"{out}/failed-paused.jsonl", "a").write("".join(json.dumps(r) + "\n" for r in failed))
    os.remove(path)
    tasks = {r["task"] for r in failed}
    done = [json.loads(l) for l in open(f"{out}/runs.jsonl")] if os.path.exists(f"{out}/runs.jsonl") else []
    open(f"{out}/superseded.jsonl", "a").write("".join(json.dumps(r) + "\n" for r in done if r["task"] in tasks))
    open(f"{out}/runs.jsonl", "w").write("".join(json.dumps(r) + "\n" for r in done if r["task"] not in tasks))
    return tasks

def main():
    a = argparse.ArgumentParser()
    a.add_argument("tasks"); a.add_argument("out"); a.add_argument("repo")
    a.add_argument("--wave", action="append", required=True)
    a.add_argument("--start-after-ms", type=int, default=0)
    a.add_argument("--attempts", type=int, default=4)
    o = a.parse_args()
    branch = subprocess.run(["git", "-C", o.repo, "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, text=True).stdout.strip()
    after = o.start_after_ms
    try:
        for wave in o.wave:
            arms, _, ref = wave.partition("@")
            if ref:
                install(o.repo, ref)
            for attempt in range(o.attempts):
                resets = wait_for_window(after)
                log(f"wave {arms}, attempt {attempt + 1}")
                subprocess.run([sys.executable, "-I", f"{HERE}/paired.py", "run", o.tasks, arms, o.out,
                                "--parallel", "2", "--budget", "400"], check=False)
                failed = set_aside_failed(o.out)
                if not failed:
                    break
                log(f"paused: {sorted(failed)} failed, waiting for the next window")
                after = resets or 0
            else:
                log(f"wave {arms} still has failures after {o.attempts} attempts")
    finally:
        if branch != "HEAD":
            install(o.repo, branch)
    log("done")

if __name__ == "__main__":
    main()
