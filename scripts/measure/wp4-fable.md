# WP4: Fable criteria for short questions

Decision: go.
Short design questions now go to Opus 5.5 instead of Fable 5.1, and no good-enough verdict was lost.

## Change

The Fable 5.1 description in `MAIN_MODELS` named "system architecture and design trade-offs", which matched a three-sentence design question.
The new description names three kinds of work.
They are a long autonomous task with many steps, a correctness-critical change, and a subtle concurrency, security or data-loss problem that needs deep investigation.
The Opus 5.5 description now also names a design question or trade-off answered in a few sentences.
The plan also suggested naming "a short explanation" under Opus.
The change leaves that out, because Sonnet 5.5 already owns explanations, and those words can pull them up to Opus.

## Replay

`route_all.py` routed the first prompt of the same 199 past sessions with the old and the new text, both on October 19, 2026.
`replay_cost.py` repriced each session's own requests at the routed model.
Claude Code had deleted 8 of the transcripts, so 191 sessions are priced.

| Route | Old text | New text |
| --- | --- | --- |
| Sonnet 5.5 | 107 | 99 |
| Opus 5.5 | 81 | 93 |
| Fable 5.1 | 11 | 7 |

| Move | Sessions | Cost change |
| --- | --- | --- |
| Fable 5.1 to Opus 5.5 | 8 | -$50.72 |
| Sonnet 5.5 to Opus 5.5 | 8 | +$8.75 |
| Opus 5.5 to Fable 5.1 | 4 | +$2.41 |
| Total on 191 sessions | 20 | -$39.56, -2.5% |

The 8 sessions that left Fable include the three short design questions: the write-ahead log in five sentences, CRDT or OT in three sentences, and the headless workbench question.
The 4 sessions that moved to Fable are the same read-only security-rule check, routed four times.
The new text names security problems, and the check is about a security rule.
The 8 sessions that moved from Sonnet to Opus were close calls, with no more than 8% of the vote on Fable.
They moved because the Opus description got longer, and Opus now takes more of the vote.

The classifier's own noise is smaller than this change.
The same old text, replayed once earlier in October and once on October 19, moved 4 of 199 routes.
Two of those 4 moves were from Opus to Fable on long sessions, which changed the replay cost by 3.4%.
So a cost change of a few percent on this replay is within noise, but the 8 Fable-to-Opus moves are not.

## Live check

The two Fable tasks of the paired test ran again on the new build, at the same time as an Opus 5.5 medium arm.
One Opus judge per task rated both answers blind.

| Task | Opus 5.5 medium | New build | New route | Opus good enough | New build good enough | Better |
| --- | --- | --- | --- | --- | --- | --- |
| r104 WAL design in five sentences | $0.25 | $0.22 | Opus 5.5 | yes | yes | new build |
| r105 CRDT or OT in three sentences | $0.23 | $0.20 | Opus 5.5 | yes | yes | new build |

On Fable 5.1 in the baseline, the same two tasks cost $1.05.
On the new build they cost $0.42, which is 60% less, and both answers stayed good enough.

## Cost of this step

The two replays of 199 prompts cost about 3 cents in classifier calls.
The live check cost $0.89, and its 2 judges cost $0.36.
