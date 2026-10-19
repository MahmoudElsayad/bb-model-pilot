# WP3: cheap first, verify, escalate

Decision: no-go.
The verifier fails the discrimination test, and the cascade costs more than Opus alone.
Nothing ships from this package.

## Method

`wp3_verify.py` gave a verifier the task and the final answer, and nothing else.
The verifier ran on Opus 5.5 low effort in a fresh Claude Code thread, with no tools.
It answered the plan's question: can an engineer act on this without asking again, and does the answer cite its evidence?
The prompt also listed three reasons to answer no.
They are a guess that was not checked, a hedge where a check was possible, and a conclusion without evidence.
It ran on 32 existing answers to the 8 read-only tasks.
16 answers came from the earlier blind test in `report-2.md`, and 16 came from the live baseline in `baseline.md`.
The blind judge's good-enough verdicts are the reference.

Command:

```sh
python3 -I scripts/measure/wp3_verify.py OUT/verdicts.jsonl --pairs BLIND2 BLIND2_KEY JUDGE2 --paired TASKS BASELINE_DIR
```

## Discrimination

| Judge | Verifier said no | Verifier said yes |
| --- | --- | --- |
| Not good enough (4 answers) | 3 | 1 |
| Good enough (28 answers) | 3 | 25 |

The verifier flagged both Mergify answers that guessed without opening the log, and the T3 Code answer that hedged instead of checking upstream.
It passed one answer that the judge rejected, an earlier Opus answer to the write-ahead log design question.
It flagged 3 answers that the judge accepted.
Two were answers to the heat-equation question, which it faulted for citing no papers, although the question needs no sources.
The third was an earlier T3 Code answer.
The go rule allows at most 1 false flag, so the verifier fails.

## Economics

The cascade runs Sonnet 5.5 first, then the verifier, then Opus 5.5 again for every flagged task.
The costs are the baseline's own, on the 5 read-only tasks that Model Pilot sent to Sonnet 5.5.

| Task | Sonnet 5.5 | Verifier | Flagged | Opus 5.5 | Cascade |
| --- | --- | --- | --- | --- | --- |
| r100 | $0.23 | $0.17 | yes | $0.82 | $1.23 |
| r101 | $0.42 | $0.18 | no | $0.77 | $0.60 |
| r102 | $0.10 | $0.17 | no | $0.26 | $0.27 |
| r103 | $0.15 | $0.17 | yes | $0.60 | $0.92 |
| r107 | $1.34 | $0.19 | no | $1.60 | $1.53 |
| Total | | | | $4.06 | $4.54 |

Both sides end with 5 good-enough answers.
The cascade costs 12% more than Opus alone.
A verifier call costs $0.18 on average, which is more than a whole Sonnet answer on 2 of the 5 tasks.
The Opus rerun after a flag costs as much as an Opus run from the start, so every flag erases the Sonnet saving.

## Cost of this step

The 32 verifier calls cost $5.80.
