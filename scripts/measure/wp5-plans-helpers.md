# WP5: a higher bar for plans and helpers, and helpers that do not hang

Decision: go.
On the three tasks of the test, the cost fell 16%, and every answer stayed good enough.

## Change

A plan or a helper now needs 0.65 of the classifier's shape vote, the same bar as a model pick.
Below it, the main agent does the work.
If the agent meets bulk, the delegate tool is still available.
In auto permission mode, Haiku 4.5 is no longer offered as a helper model.
The delegate tool now stops a helper as soon as it asks for an approval, and tells the main agent what it asked for.

## The helper bug

`baseline.md` describes the bug.
A Haiku 4.5 helper that needed the network, an MCP tool, or a file outside its workspace asked for an approval.
The helper's thread is hidden, so nobody saw the prompt, and the delegate tool's call ended after 302 seconds.
Across all Model Pilot threads in the test projects, 18 of 21 Haiku helpers stopped this way.

A plain Claude Code thread reproduces it.
In auto permission mode, Haiku 4.5 asked for approval of the Linear `list_teams` tool, and Sonnet 5.5 ran the same prompt without one.
Claude Code's auto permission mode does not cover Haiku 4.5.

After the change, the build started 8 helpers in auto permission mode, in the coupon and m4 tasks.
All 8 ran on Sonnet 5.5, and none asked for an approval, including the m4 helpers that read GitHub and Linear.
The fail-fast path is covered by a unit test only, because no helper on the new build asked for an approval.

## Decisions that change

`wp5_count.py` read every recorded decision.

| Source | Decisions | Plans | Plans below 0.65 | Helpers | Helpers below 0.65 |
| --- | --- | --- | --- | --- | --- |
| Live Model Pilot threads | 66 | 16 | 7 | 3 | 3 |
| Replay of 199 first prompts | 199 | 55 | 21 | 9 | 7 |

So the bar turns about 40% of plans and most helper decisions into work for the main agent.

## Live test

The coupon task and the two planned read-only tasks of the baseline ran on the new build.
The two planned tasks are r101 and r107, which the baseline planned with 51% and 60% of the vote.
An Opus 5.5 medium arm ran at the same time, and one Opus judge per task rated both answers blind.

| Task | Baseline Model Pilot | New build | New route | Good enough | Opus 5.5 medium, same time |
| --- | --- | --- | --- | --- | --- |
| r101 Unassigned Web bugs | $0.42, plan, helper | $0.26 | Sonnet 5.5, main, plan or helper vote 0.56 | yes | $1.01 |
| r107 Flaky-test skill | $1.34, plan, helpers | $1.01 | Sonnet 5.5, main, plan or helper vote 0.60 | yes | $1.59 |
| coupon | $1.00, plan, helpers | $1.06 | Opus 5.5, plan vote 0.72, Sonnet helpers | yes | $0.48 |
| Total | $2.76 | $2.33 | | 3 of 3 | $3.08 |

The first r107 run on the new build was not good enough, and it does not count here.
In that session, Claude Code's tool search found no Slack tool, so the agent did not read the Slack posts that the task names.
The Opus thread at the same time had Slack.
The missing connector is a session problem, not a routing one, so r107 ran once more on the same build, and that run read Slack.
The first run cost $0.35.

The coupon task still got a plan, because the vote for it was 0.72.
Its helpers ran on Sonnet 5.5 and finished without hanging.

## Cost of this step

The three pairs cost $4.76, and the second r107 run cost $1.01.
The 4 judges cost $0.88, and the two reproduction threads cost $0.31.
The step cost $6.96 in total.
