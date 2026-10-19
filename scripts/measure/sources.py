# Reads every model request from the local agent logs: Claude Code, Codex and Pi.
# Claude Code and Codex logs also hold the runs of BB, T3 Code and Model Pilot, because those apps run the same agents.
import datetime, glob, json, os

HOME = os.path.expanduser("~")
CLAUDE = [f"{HOME}/.claude/projects"]
CODEX = [f"{HOME}/.codex/sessions", f"{HOME}/.codex/archived_sessions"]
PI = [f"{HOME}/.pi/agent/sessions"]
T3_SCAN = f"{HOME}/.t3/userdata/usage-scan-cache.json"

def when(ts):
    if isinstance(ts, (int, float)):
        return datetime.datetime.fromtimestamp(ts / 1000, datetime.timezone.utc)
    return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))

def files(roots, since):
    cut = since.timestamp()
    for root in roots:
        for f in glob.glob(f"{root}/**/*.jsonl", recursive=True):
            if os.path.getmtime(f) >= cut:
                yield f

def request(source, f, session, ts, model, new, w5, w1h, read, out, helper=False, rid=None):
    return {"source": source, "file": f, "session": session, "ts": ts, "model": model, "new": new, "w5": w5,
            "w1h": w1h, "read": read, "out": out, "helper": helper, "id": rid}

def claude_session(f):
    """The top session of a transcript: helpers live in <session>/subagents/<agent>.jsonl."""
    parts = f.split(os.sep)
    if "subagents" in parts:
        return parts[parts.index("subagents") - 1]
    return os.path.basename(f)[:-6]

def claude(since, roots=CLAUDE, paths=None):
    """One request per message id. A response is logged once per content block, so keep the largest usage."""
    best = {}
    for f in paths or files(roots, since):
        for line in open(f, errors="ignore"):
            if '"usage"' not in line:
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            m = e.get("message") or {}
            u = m.get("usage")
            if e.get("type") != "assistant" or not u or not m.get("id") or not m.get("model", "").startswith("claude-"):
                continue
            ts = when(e["timestamp"])
            if ts < since:
                continue
            w = u.get("cache_creation_input_tokens") or 0
            w1h = (u.get("cache_creation") or {}).get("ephemeral_1h_input_tokens") or 0
            r = request("claude-code", f, claude_session(f), ts, m["model"], u.get("input_tokens") or 0, w - w1h, w1h,
                        u.get("cache_read_input_tokens") or 0, u.get("output_tokens") or 0,
                        helper="subagents" in f or bool(e.get("isSidechain")), rid=m["id"])
            old = best.get(m["id"])
            if old is None or r["out"] > old["out"]:
                best[m["id"]] = r
    return list(best.values())

def codex(since, roots=CODEX, paths=None):
    """One request per change of the cumulative token count. A forked rollout copies its parent's events, so the
    pair (cumulative, last) is counted once across files."""
    seen, out = set(), []
    for f in paths or files(roots, since):
        model, session, last_total = None, os.path.basename(f)[-42:-6], None
        for line in open(f, errors="ignore"):
            if '"turn_context"' not in line and '"token_count"' not in line and '"session_meta"' not in line:
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            p = e.get("payload") or {}
            if e.get("type") == "session_meta":
                session = p.get("id", session)
            elif e.get("type") == "turn_context":
                model = p.get("model", model)
            elif p.get("type") == "token_count" and p.get("info"):
                total, last = p["info"].get("total_token_usage") or {}, p["info"].get("last_token_usage") or {}
                key = (tuple(sorted(total.items())), tuple(sorted(last.items())))
                if total.get("total_tokens") == last_total or key in seen:
                    continue
                last_total = total.get("total_tokens")
                seen.add(key)
                ts = when(e["timestamp"])
                if ts < since:
                    continue
                cached, write = last.get("cached_input_tokens") or 0, last.get("cache_write_input_tokens") or 0
                out.append(request("codex", f, session, ts, model or "unknown", max((last.get("input_tokens") or 0) - cached - write, 0),
                                   0, write, cached, last.get("output_tokens") or 0))
    return out

def pi(since, roots=PI, paths=None):
    out = []
    for f in paths or files(roots, since):
        for line in open(f, errors="ignore"):
            if '"usage"' not in line:
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            m = e.get("message") or {}
            u = m.get("usage")
            if e.get("type") != "message" or m.get("role") != "assistant" or not u:
                continue
            ts = when(e["timestamp"])
            if ts < since:
                continue
            out.append(request("pi", f, os.path.basename(f)[:-6], ts, f"{m.get('provider')}/{m.get('model')}", u.get("input") or 0,
                               0, u.get("cacheWrite") or 0, u.get("cacheRead") or 0, u.get("output") or 0, rid=m.get("responseId")))
    return out

def deleted_claude(since, known, path=T3_SCAN):
    """Claude Code deletes transcripts after 30 days. T3 Code's usage scan keeps one row per request of every
    transcript that it read: [ms, model index, _, uncached, read, write, output, _, "msg:req", ...].
    The row does not split writes by TTL, so they count as 1-hour writes, the TTL Claude Code uses."""
    if not os.path.exists(path):
        return []
    scan, out = json.load(open(path)), []
    for f, v in scan["files"].items():
        if v["p"] != "claude" or os.path.exists(f):
            continue
        for row in v["r"]:
            ts, mid = when(row[0]), (row[8] or "").split(":")[0]
            model = scan["models"][row[1]]
            if ts < since or mid in known or not model.startswith("claude-"):
                continue
            known.add(mid)
            out.append(request("claude-code", f, claude_session(f), ts, model, row[3], 0, row[5], row[4], row[6],
                               helper="subagents" in f, rid=mid))
    return out

def all_requests(since, until=None):
    cc = claude(since)
    rs = cc + deleted_claude(since, {r["id"] for r in cc}) + codex(since) + pi(since)
    return [r for r in rs if until is None or r["ts"] < until]
