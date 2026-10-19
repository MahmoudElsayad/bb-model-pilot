# Baseline, September 1 to October 17, 2026

This file holds the numbers that every later change compares against.

## Period bill

Source: `python3 -I scripts/measure/bill.py --since 2026-09-01`, run on October 17, 2026.
The bill counts 114,253 requests and $8,286 at list prices.

| Category | Cost | Share |
| --- | --- | --- |
| Cache write | $1,851 | 22% |
| Cache read | $4,316 | 52% |
| Uncached input | $759 | 9% |
| Output | $1,360 | 16% |

| Source | Model | Requests | Cost | Share |
| --- | --- | --- | --- | --- |
| Codex | GPT-6 Astra | 17,518 | $3,015 | 36% |
| Claude Code | Opus 5.5 | 27,389 | $2,415 | 29% |
| Claude Code | Fable 5.1 | 4,304 | $1,589 | 19% |
| Codex | GPT-6.1 Sol | 42,097 | $966 | 12% |
| Claude Code | Sonnet 5.5 | 4,676 | $266 | 3% |
| Codex | GPT-6 Luna | 16,566 | $24 | 0.3% |
| Claude Code | Haiku 4.5 | 735 | $10 | 0.1% |

Claude Code is $4,281 of the bill, and Codex is $4,005.
Claude Code helpers are $1,037 of the Claude Code part.
Codex has no cache-write cost, so its bill is cache reads, uncached input, and output.
About 110 million tokens are unpriced, because `routing/models.ts` has no rate for GPT-5.5, GPT-5.6 Terra, or Kimi K3.

## Large Claude Code cache writes

508 requests wrote 40k tokens or more, at $1,015, which is 55% of the Claude Code write cost.

| Cause | Requests | Cost | Share |
| --- | --- | --- | --- |
| Resume after the 1-hour cache expired | 125 | $530 | 52% |
| Prefix broke within 1 hour | 103 | $287 | 28% |
| Large append within 5 minutes | 43 | $85 | 8% |
| First request of a transcript | 204 | $59 | 6% |
| Gap of 5 to 60 minutes | 21 | $30 | 3% |
| Model switch | 12 | $23 | 2% |

## Live paired baseline

Run on October 17 to 19, 2026, with `paired.py` on 13 frozen tasks: 8 read-only tasks, 4 multi-turn tasks, and the coupon task.
Both arms ran each task at the same time on the same data.
Opus 5.5 medium ran on Claude Code, and Model Pilot 0.4.4 chose from Claude models, because the Codex spend cap was used up.
Costs come from every thread's transcripts, helpers included.
One Opus judge per task rated both answers blind.
The 4 multi-turn tasks ran again on October 19, with follow-ups sent as user messages and the read-only rule in every message.
Their first run sent the follow-ups as messages from another thread, so it does not count.

| Task | Opus 5.5 medium | Model Pilot | Model Pilot route | Opus good enough | Model Pilot good enough | Better |
| --- | --- | --- | --- | --- | --- | --- |
| r100 Mergify merge failure | $0.82 | $0.23 | Sonnet 5.5 | yes | no | Opus |
| r101 Unassigned Web bugs | $0.77 | $0.42 | Sonnet 5.5, plan, helper | yes | yes | Opus |
| r102 Heat equation and options | $0.26 | $0.10 | Sonnet 5.5 | yes | yes | Opus |
| r103 T3 Code plugins | $0.60 | $0.15 | Sonnet 5.5 | yes | no | Opus |
| r104 WAL design in five sentences | $0.24 | $0.53 | Fable 5.1 | yes | yes | Model Pilot |
| r105 CRDT or OT in three sentences | $0.23 | $0.52 | Fable 5.1 | yes | yes | Model Pilot |
| r106 Automate the CDN upload | $1.56 | $2.15 | Opus 5.5, plan, helper | yes | yes | Model Pilot |
| r107 Flaky-test skill | $1.60 | $1.34 | Sonnet 5.5, plan, helpers | yes | yes | Opus |
| m1 CDN publish, 3 turns | $0.89 | $0.36 | Sonnet 5.5 | yes | no | Opus |
| m2 Document Editor reload, 3 turns | $2.59 | $0.27 | Sonnet 5.5 | yes | no | Opus |
| m3 AX evaluation project, 3 turns | $1.42 | $0.71 | Sonnet 5.5, helpers | yes | yes | Opus |
| m4 1.23.0 release freeze, 3 turns | $0.79 | $0.73 | Sonnet 5.5, plan, helper | yes | no | Model Pilot |
| coupon | $0.49 | $1.00 | Opus 5.5, plan, helpers | yes | yes | Opus |
| Total | $12.27 | $8.50 | | 13 of 13 | 8 of 13 | 9 Opus, 4 Model Pilot |

Cost per good-enough answer: Opus 5.5 medium $0.94, Model Pilot $1.06.
Model Pilot is 31% cheaper per task set, but it loses 5 good-enough verdicts, so it costs more per good-enough answer.

| Category | Opus 5.5 medium | Model Pilot |
| --- | --- | --- |
| Cache write | $7.19 | $5.51 |
| Cache read | $3.15 | $1.78 |
| Uncached input | $0.00 | $0.00 |
| Output | $1.93 | $1.20 |

Model Pilot's $8.50 splits into Sonnet 5.5 $3.82, Opus 5.5 $2.41, Fable 5.1 $1.05, and helpers $1.22 (Haiku 4.5 $0.75, Sonnet 5.5 $0.47).
The classifier cost less than one cent.

### What the misses have in common

In r100, r103, m1, and m2, Model Pilot ran on Sonnet 5.5 and stopped at a guess or a hedge that one more check would have settled.
In m4, the judge preferred Model Pilot's answer, but it found that neither answer was good enough by its own test of the final state.
Opus did the extra check in each case, for example the Buildkite log in r100 and a live test of the draft in m2.

### Helpers that hang

Every Haiku 4.5 helper that needed the network, an MCP tool, or a file outside its workspace stopped at an approval prompt.
A helper's thread is hidden, so nobody saw the prompt.
The delegate tool's call ended after 302 seconds, BB stopped the helper, and the main agent then did the work itself.
In the baseline it happened in r101, r106, r107, and m3, and in the first run of m3 and m4.
Across all Model Pilot threads in these projects, 18 of 21 Haiku helpers stopped this way.
The 9 Sonnet 5.5 and GPT-6 Luna helpers asked for no approval, but they only worked inside their workspace.
A plain Claude Code thread reproduces it: in auto permission mode, Haiku 4.5 asked for approval of the Linear `list_teams` tool, and Sonnet 5.5 ran the same prompt without one.
Claude Code's auto permission mode does not cover Haiku 4.5.
