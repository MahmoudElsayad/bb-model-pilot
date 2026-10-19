# Measurement scripts

These scripts measure what the agents cost, from the local agent logs.
Every Model Pilot change is measured with them before it ships.

## Sources

The scripts read the Claude Code transcripts in `~/.claude/projects`, with helper transcripts in `<session>/subagents/`.
They read the Codex rollouts in `~/.codex/sessions` and `~/.codex/archived_sessions`.
They read the Pi sessions in `~/.pi/agent/sessions`.
BB, T3 Code, and Model Pilot run the same agents, so their runs are in these logs too.

Claude Code deletes transcripts after 30 days.
For a deleted transcript, the scripts read its requests from T3 Code's usage scan in `~/.t3/userdata/usage-scan-cache.json`.
That scan does not split cache writes by TTL, so the scripts price those writes as 1-hour writes.

opencode logged 2 messages in September and October 2026, and Cursor keeps no token counts on disk, so the scripts do not read them.

## Prices

`prices.py` reads the rates from `routing/models.ts`, so the plugin and the scripts use one table.
A 5-minute cache write costs 1.25 times the input rate, and a 1-hour cache write costs the table's `cacheWrite` rate.
A model that the table lacks is priced as its successor in `ALIAS`, or reported as unpriced.

## Rules

A Claude Code response is logged once per content block with the same message id.
The scripts count it once and keep the largest output count, which is the final one.
A Codex rollout logs its cumulative token count, and a forked rollout copies the events of its parent.
The scripts count a Codex request once per new cumulative count across all files.

## Commands

Print the bill of a period by source, model, and token category, with the causes of large cache writes:

```sh
python3 -I scripts/measure/bill.py --since 2026-09-01 --until 2026-10-18 --json bill.json
```

Run a frozen task set on two or more arms at the same time, then judge and report it:

```sh
python3 -I scripts/measure/paired.py run    TASKS ARMS OUT --budget 30 --parallel 3
python3 -I scripts/measure/paired.py blind  TASKS OUT opus pilot
python3 -I scripts/measure/paired.py judge  OUT
python3 -I scripts/measure/paired.py report TASKS OUT opus pilot
```

`TASKS` holds the task prompts. Keep it outside the repo, because the prompts come from private sessions.
`ARMS` maps each arm name to its `bb thread spawn` flags, for example `{"opus": ["--provider", "claude-code", "--model", "claude-opus-5-5", "--reasoning-level", "medium"], "pilot": ["--provider", "auto"]}`.
An arm can also run a project in its own workspace: `{"rtk": {"flags": [...], "environments": {"PROJECT_ID": "/path/to/worktree"}}}`.
`blind` and `report` take any number of arms, and one judge rates all of a task's answers in one blind call.
A run that fails, for example during a network outage, goes to `OUT/failed.jsonl`, and its task runs again next time.
If the runner stops while threads are still working, `paired.py adopt TASKS ARMS OUT TASK ARM THREAD` finishes that thread's remaining turns.
The runner sends follow-up turns as user messages, and it finds Model Pilot helpers through their lifecycle owner, because most helpers have no parent thread.
Before it sends the next message, it waits until the thread has no queued message, no background agent and no busy child thread.
A background helper's report starts a turn of its own, so the turn count alone does not say that an answer is complete.

## Measurements of the cost plan

Each work package has a result file with its method, numbers and go or no-go decision:

| Package | Result | Scripts |
| --- | --- | --- |
| WP0 harness and baseline | `baseline.md` | `bill.py`, `paired.py` |
| WP1 compact before the cache expires | `wp1-simulation.md`, no-go | `wp1_sim.py`, `wp1_forks.py` |
| WP2 effort for every message | `wp2-effort.md`, go | `wp2_cache.py`, `turn_cost.py` |
| WP3 verifier before escalating | `wp3-verifier.md`, no-go | `wp3_verify.py` |
| WP4 Fable criteria | `wp4-fable.md`, go | `route_all.py`, `replay_cost.py` |
| WP5 bar for plans and helpers | `wp5-plans-helpers.md`, go | `wp5_count.py` |
