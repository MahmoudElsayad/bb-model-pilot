# Final run: release candidate against Opus, RTK and Model Pilot 0.4.4

The release candidate did not beat Model Pilot 0.4.4.
It cost $10.59 for 9 good-enough answers out of 13, which is $1.18 per good-enough answer.
Model Pilot 0.4.4 cost $7.82 for 9 good-enough answers, which is $0.87 per good-enough answer.
The RTK compression control was the best Claude Code arm at $1.01 per good-enough answer, with 12 of 13 good enough.

## Arms

| Arm | What runs |
| --- | --- |
| opus | Claude Code, Opus 5.5, medium effort |
| rc | Model Pilot at `cost-plan` 0d2b2e6, with WP4, WP5 and WP2 |
| rtk | Claude Code, Opus 5.5, medium effort, with the RTK 1.0.1 Bash hook in a separate worktree |
| mp044 | Model Pilot 0.4.4 at 779b8ab |

All four arms ran the same 13 tasks from `tasks.json`, with the read-only rule in every research prompt.
The runner sent each follow-up as a user message after the thread settled.
One judge thread per task rated the four answers blind, under the labels A to D, in a random order.
If the judge says that an answer meets the request, the answer is good enough.
Each verdict compares an answer with the other three, so these rates are not comparable with `baseline.md`, which compared two arms.

## Result

| Arm | Cost | Good enough | Cost per good-enough answer | Best on |
| --- | --- | --- | --- | --- |
| opus | $12.82 | 10 of 13 | $1.28 | 5 |
| rc | $10.59 | 9 of 13 | $1.18 | 1 |
| rtk | $12.07 | 12 of 13 | $1.01 | 5 |
| mp044 | $7.82 | 9 of 13 | $0.87 | 2 |

## Token categories

| Arm | Cache write | Cache read | Uncached input | Output |
| --- | --- | --- | --- | --- |
| opus | $8.17 | $2.90 | $0.00 | $1.76 |
| rc | $5.56 | $3.03 | $0.00 | $1.99 |
| rtk | $7.05 | $3.13 | $0.00 | $1.89 |
| mp044 | $5.31 | $1.57 | $0.00 | $0.94 |

## Per task

| Task | opus | rc | rtk | mp044 | opus good | rc good | rtk good | mp044 good | Better |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| r100 | $0.87 | $0.22 | $0.89 | $0.22 | yes | no | yes | no | rtk |
| r101 | $0.83 | $0.24 | $0.64 | $0.49 | yes | no | yes | yes | opus |
| r102 | $0.23 | $0.09 | $0.24 | $0.09 | yes | yes | yes | yes | opus |
| r103 | $0.50 | $0.16 | $0.50 | $0.19 | yes | no | yes | no | opus |
| r104 | $0.19 | $0.18 | $0.26 | $0.80 | no | no | no | yes | mp044 |
| r105 | $0.21 | $0.15 | $0.28 | $0.44 | no | yes | yes | yes | rtk |
| r106 | $1.22 | $1.72 | $0.94 | $1.14 | no | yes | yes | yes | rc |
| r107 | $3.46 | $0.86 | $1.94 | $1.38 | yes | yes | yes | yes | rtk |
| m1 | $1.06 | $0.26 | $0.60 | $0.46 | yes | yes | yes | yes | opus |
| m2 | $1.26 | $2.62 | $2.82 | $0.33 | yes | yes | yes | no | rtk |
| m3 | $1.75 | $0.54 | $1.59 | $0.68 | yes | yes | yes | yes | opus |
| m4 | $0.79 | $2.84 | $0.88 | $0.65 | yes | yes | yes | no | rtk |
| coupon | $0.45 | $0.70 | $0.49 | $0.95 | yes | yes | yes | yes | mp044 |

## What the result says

The release candidate lost three research tasks that 0.4.4 or Opus answered well.
On r100, the release candidate and 0.4.4 both guessed at the CI failure and did not open the Buildkite log.
On r101, it recommended an issue that was already in progress and missed the strongest candidates.
On r103, it did not check the source.
On r104, every arm except 0.4.4 broke the five-sentence limit.
On r100 to r104, the release candidate spent no more than 0.4.4.
The WP4 Fable criteria cut cost on these tasks, and the answers got worse.
On the multi-turn tasks m2 and m4, the release candidate was good enough and 0.4.4 was not.
The release candidate paid $2.62 and $2.84 for them, against $0.33 and $0.65.
Each arm ran each task once, so one task can move an arm's rate by about 8 points.
This result does not show that the release candidate is better than 0.4.4.
I do not recommend a release of the candidate as it stands.

RTK cost 6% less than Opus with more good-enough answers.
Its cache writes were $1.12 lower, which fits shorter tool output in the cached prompt.

## WP1 simulated saving, reported separately

WP1 did not run in the final run, because it was a no-go.
The realistic simulated saving is $338, which is 4.1% of the period bill, for compaction over the next 20 requests at X=200k.
The plan's own rule, compaction until the next observed compaction, gives $695, which is 8.4%.
The fork test lost good-enough quality on one of four threads.
`wp1-simulation.md` has the method.

## Spend

The final run, from 2026-10-19 12:39 UTC to the judge, used 95 threads that cost $61.35.
That total comes from `spend.py --since 2026-10-19T12:35:00Z`.

| Part | Cost |
| --- | --- |
| The 52 runs in the table | $43.30 |
| The judge, 13 threads | $3.17 |
| Window checks | $0.14 |
| Runs set aside after the network outage and the exhausted window, and the first r101 run on 0.4.4 | $14.74 |

## Deviations from the plan

1. BB did not allow a second Model Pilot variant beside the first, so 0.4.4 ran as a second wave after the three other arms.
2. Wave 1 first failed on 14 runs with `ENOTFOUND`. When the five-hour window ran out, a second attempt stopped. `final_run.py` set aside the finished arms of each failed task, so all arms of a task ran in the same window.
3. RTK ran in its own worktrees, `thr_b5s4qp9y75/rtk/`, because its hook lives in project-level Claude Code settings. Those worktrees were at the same commits as the other arms.
4. Model Pilot 0.4.4 helpers wait on approvals that nobody can see. The runner waited for every child thread, so it stopped on r101 for 30 minutes. `settled()` now stops a child that waits on an approval after the main turn ends, and r101 ran again.

## Files

All run data lives outside the repo, in `~/.bb/thread-storage/thr_b5s4qp9y75/measure/final/`.

| File | Content |
| --- | --- |
| `runs.jsonl` | the 52 runs, with thread IDs and prices |
| `superseded.jsonl`, `failed-paused.jsonl`, `failed-outage.jsonl` | runs set aside |
| `blind/`, `blind.key.json` | the blind answers and the label key |
| `judge.json` | the verdicts and reasons |
| `report.txt` | the report output |
| `spend.txt`, `spend.json` | the spend total and its threads |
| `orchestrator.log`, `wave1.log`, `wave1b.log` | the run logs |
