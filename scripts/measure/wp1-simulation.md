# WP1 simulation: compact an idle thread before its cache expires

This file holds the offline part of WP1 in the cost plan.
The period is September 1 to October 17, 2026.
The question: if Model Pilot compacts an idle Opus or Fable thread at minute 55 of its idle time, how much does the Claude Code bill fall?

## Decision

No-go.
The live quality test lost a good-enough verdict on 1 of 4 threads, and the go rule allows none.
The realistic simulated saving is 4.1% of the period bill, below the 5% bar.
Only the plan's most favorable assumption gives 8.4%.
Nothing ships from this package.

## Result

The go rule needs a net saving of at least 5% of the $8,286 period bill, which is $414.
The result depends on one assumption that the logs cannot settle: how long a compacted thread stays small after it resumes.

| How long the compacted context stays small | Best X | Net saving | Share of $8,286 | Share of $4,281 Claude Code |
| --- | --- | --- | --- | --- |
| Until the next observed compaction (plan's rule) | 200k | $695 | 8.4% | 16.2% |
| For the next 20 requests | 200k | $338 | 4.1% | 7.9% |
| Not at all, only the resume is cheaper | 300k | $184 | 2.2% | 4.3% |

The 5% bar is met only with the plan's rule, which is the most favorable assumption.
The logs argue against that rule.
Claude Code compacted 23 times in these transcripts.
After each one, the context grew from about 60k tokens back to 100k to 180k tokens within 40 to 80 requests, because the agent read the files again.
The 20-request estimate, $338 or 4.1%, is the one I consider realistic, and it is below the bar.
The live quality test (4 forked threads) can still run, but it cannot raise the saving, only lower it.

## Data

The script reads the Claude Code transcripts in `~/.claude/projects` from September 1 to October 17, 2026.
The headline numbers also include deleted transcripts from T3 Code's usage scan (`--deleted`).
With them, the simulated bill is $4,303, close to the $4,281 Claude Code part of `baseline.md`.
The scan rows keep each request's time and transcript path, so the script can order them per session.
The scan rows do not split cache writes by TTL, so they count as 1-hour writes, as in `bill.py`.
Without the deleted transcripts, the bill is $3,371.
The best net saving is then $600 (plan's rule), $327 (20 requests), or $211 (resume only), so the conclusion does not change.

| Data | Requests | Main sessions | Idle gaps over 55 minutes followed by a resume | Sessions that ended idle |
| --- | --- | --- | --- | --- |
| Live transcripts and deleted transcripts | 37,312 | 969 | 142 | 969 |
| Live transcripts only | 30,544 | 933 | 112 | 933 |

Helper transcripts had 3 idle gaps followed by a resume in the whole period, so the policy ignores helpers.

## Method

The script groups the requests by transcript and orders them by time.
The context size of a request is its cache read plus its cache writes plus its uncached input.
An idle gap is the time from a request to the next request of the same transcript.
For the last request, the gap runs to the end of the period.

An observed compaction is a request whose context fell by more than half within one hour.
The previous context must be above 20k tokens.
The median context right after an observed compaction is 87,959 tokens with the deleted transcripts (29 compactions), and 65,940 tokens without them (23 compactions).
The script uses that median as the size of a compacted context.
When the current context is smaller, it uses the current context.
Claude Code's compact-summary messages have a median length of about 4,000 tokens (31 summaries), so a compaction pays 4,000 output tokens.

The policy runs at minute 55 of every idle gap of a main transcript.
If the context is above X and the model is Opus or Fable, the thread compacts.
A compaction costs one cache read of the full context, the summary at the output price, and one 1-hour cache write of the compacted context.
Some sessions used 5-minute cache writes, so their cache expired before minute 55.
For them, the full context costs 1.25 times the input price instead of a cache read.

If the resume comes within one hour of the compaction, it reads the compacted context from cache.
Otherwise, it writes the compacted context again.
The new tokens of the resume request cost the write price in both cases.
The saving on the resume is the observed cost of the resume request without its output, minus that simulated cost.

After the resume, every later request reads fewer tokens: the difference between the context at the gap and the compacted context.
The reduction applies first to the cache read and then to the cache write of each request, and never exceeds them.
It stops at the next observed compaction, or after the horizon of the row: 20 requests, or none.
At a later gap the policy decides on the smaller simulated context.

A wasted compaction is one at a gap after which the session never resumed in the period.
It pays the full compaction fee and saves nothing.

## Sweep, live and deleted transcripts

| Context stays small | X | Compactions | Resumes | Wasted | Fee | Wasted fee | Saving on resume | Saving after resume | Net | Share of $8,286 | Share of $4,281 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| to next observed compaction | 50k | 352 | 132 | 220 | $408 | $222 | $414 | $498 | $504 | 6.1% | 11.8% |
| to next observed compaction | 100k | 232 | 102 | 130 | $299 | $146 | $337 | $574 | $612 | 7.4% | 14.3% |
| to next observed compaction | 150k | 141 | 70 | 71 | $197 | $85 | $247 | $636 | $686 | 8.3% | 16.0% |
| to next observed compaction | 200k | 93 | 53 | 40 | $144 | $54 | $201 | $638 | $695 | 8.4% | 16.2% |
| to next observed compaction | 300k | 55 | 34 | 21 | $93 | $33 | $136 | $570 | $613 | 7.4% | 14.3% |
| 20 requests | 50k | 365 | 141 | 224 | $428 | $226 | $417 | $170 | $159 | 1.9% | 3.7% |
| 20 requests | 100k | 243 | 111 | 132 | $317 | $149 | $345 | $240 | $268 | 3.2% | 6.3% |
| 20 requests | 150k | 162 | 82 | 80 | $229 | $95 | $286 | $271 | $328 | 4.0% | 7.7% |
| 20 requests | 200k | 115 | 65 | 50 | $175 | $66 | $247 | $265 | $338 | 4.1% | 7.9% |
| 20 requests | 300k | 75 | 47 | 28 | $123 | $42 | $215 | $240 | $331 | 4.0% | 7.7% |
| 0 requests | 50k | 366 | 141 | 225 | $436 | $228 | $417 | $0 | -$19 | -0.2% | -0.4% |
| 0 requests | 100k | 264 | 125 | 139 | $354 | $159 | $417 | $0 | $63 | 0.8% | 1.5% |
| 0 requests | 150k | 196 | 105 | 91 | $286 | $111 | $415 | $0 | $129 | 1.6% | 3.0% |
| 0 requests | 200k | 150 | 90 | 60 | $235 | $81 | $400 | $0 | $165 | 2.0% | 3.9% |
| 0 requests | 300k | 101 | 65 | 36 | $165 | $53 | $349 | $0 | $184 | 2.2% | 4.3% |

## Wasted compactions

Most sessions end idle and never resume, so most compactions are wasted.
At X = 200k with the 20-request horizon, 50 of 115 compactions are wasted, and they cost $66 of the $175 fee.
At X = 50k, 224 of 365 are wasted, at $226.
That is why a low threshold loses money even though it catches more resumes.

## Keep-warm, for information only

Keep-warm sends a cache-read ping every 55 minutes for up to H hours of idle time, so a resume within H plus one hour reads the cache instead of writing it.
Each ping costs one cache read of the context and 50 output tokens.
Sessions that never resume also pay their pings.
Only sessions with 1-hour cache writes are counted.
Claude Code has no hook for such a ping, so keep-warm does not ship from this plan.

| H | Pings | Rewrites avoided | Ping cost | Saving | Net | Share of $8,286 |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | 2,111 | 40 | $51 | $161 | $110 | 1.3% |
| 4 | 4,155 | 59 | $96 | $233 | $137 | 1.7% |
| 8 | 8,166 | 80 | $182 | $324 | $142 | 1.7% |
| 12 | 13,005 | 99 | $278 | $396 | $118 | 1.4% |

## What the simulation does not model

It does not model the extra tokens that a compacted agent spends to read files again, apart from the horizon.
It does not model quality: a compacted thread can lose a detail that the next message needs, which the live fork test measures.
It counts sessions of every app that runs Claude Code, but Model Pilot can only compact BB threads.

## Candidates for the live quality test

These BB threads are idle Claude Code threads with an Opus context above 100k tokens.
`bb thread list` returned the 100 most recent threads, so older threads are not in this list.

| Thread | Session | Context | Last activity | Title |
| --- | --- | --- | --- | --- |
| thr_das2azgpn9 | 2ce94e8d | 219k | 2026-10-15 20:48 UTC | Add settled and unsettled chat organization |
| thr_k3h8tqi3kq | cad341b0 | 177k | 2026-10-16 15:59 UTC | Improve model routing display in chat history |
| thr_7mvi3shgkt | da39ace4 | 124k | 2026-10-16 14:50 UTC | Check whether the latest web nightly was ... |
| thr_mmg7m9d239 | c72ca7ad | 106k | 2026-10-16 13:26 UTC | (no title, project proj_zcxunqe4f8) |

thr_7mvi3shgkt is a child of thr_k3h8tqi3kq from the first paired test, with a real prompt.
thr_vuix2ffgwd (122k, "Find Slack ideas for classifying PDFs with Jev") is a spare of the same kind.

## Command

```sh
python3 -I scripts/measure/wp1_sim.py --deleted --json wp1.json
```

## Live quality test

Run on October 19, 2026, with `scripts/measure/wp1_forks.py` on 4 idle Claude Code threads on Opus 5.5.
The test did not use thr_k3h8tqi3kq, because that thread was running the measurement.
Each thread was forked twice, and one fork was compacted with `bb thread compact`.
Both forks then got the same follow-up as a user message.
The follow-up asked for specific facts from early in the conversation: names, numbers, commands, file paths and the reasons for decisions.
It also told the agent to answer from the conversation only, without tools.
One Opus 5.5 medium judge per pair rated both answers blind, with the earlier conversation as the reference.
The prompts, answers and verdicts are in `~/.bb/thread-storage/thr_b5s4qp9y75/measure/wp1/`, because they hold private text.

| Thread | Context | Compacted to | Full good enough | Compacted good enough | Better | Full follow-up | Compacted follow-up | Compaction, warm | Compaction, cold |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| thr_das2azgpn9 | 219k | 16k | yes | no | full | $1.66 | $0.34 | $0.11 | $1.82 |
| thr_7mvi3shgkt | 125k | 12k | yes | yes | full | $0.95 | $0.26 | $0.05 | $1.02 |
| thr_mmg7m9d239 | 107k | 13k | yes | yes | full | $0.78 | $0.23 | $0.06 | $0.89 |
| thr_vuix2ffgwd | 124k | 13k | yes | yes | tie | $0.94 | $0.28 | $0.07 | $1.04 |

The compacted arm lost the good-enough verdict on the largest thread, thr_das2azgpn9.
Its summary kept the commands, the thread IDs and the file path, but it lost why the person rejected the footer panel and which features the first version used.
The agent hedged on those points, and the judge marked the answer as not good enough.
On the other three threads the compacted answer was good enough, but the full answer was better on two of them and tied on one.
The judges noted that the compacted answers hedged on details that the full answers stated.

The full arm's follow-up cost $4.33 in total, because each fork resumed after the cache expired and wrote the whole context again.
The compacted arm's follow-up cost $1.12.
Claude Code logs no usage for the summary request, so the table prices it from the logged context size and the summary length.
The warm price is one cache read of the context plus the summary as output, which is what the WP1 policy pays at minute 55.
The cold price is one write of the context plus the summary, which is what this test paid, because the threads were idle for days.
With a warm compaction, the 4 resumes would cost $1.41 instead of $4.33.

The test spent about $11: $5.45 on the follow-ups, about $4.78 on the cold compactions, and $0.81 on the 4 judges.

The quality test fails the go rule, because the compacted arm lost a good-enough verdict on 1 of the 4 threads.
The cost saving per resume is real, but compaction loses the reasons and the history behind decisions, and the person often asks about those after a pause.

Run the test again with:

```sh
python3 -I scripts/measure/wp1_forks.py run    CASES OUT
python3 -I scripts/measure/wp1_forks.py judge  CASES OUT
python3 -I scripts/measure/wp1_forks.py report OUT
```

`CASES` lists the thread, the follow-up and the earlier conversation for each case.
If the runner stops after the forks exist, `wp1_forks.py adopt CASES OUT ID FULL COMPACTED` finishes that pair.
