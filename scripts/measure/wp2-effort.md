# WP2: the effort for every message

Decision: go.
The main agent's later messages cost 37% less, and every answer stayed good enough.

## Change

Model Pilot picked the reasoning effort once, on the first prompt, and kept it for the whole thread.
The classifier already runs on every later message for the delegation question.
That call now also asks how much reasoning the message needs, with the same effort scale and the same 0.65 bar.
The thread keeps its model, and only the effort changes for that message.
The route entry of the message records the effort.

## Cache test

`wp2_cache.py` ran one Opus 5.5 thread that read about 107k tokens of files at medium effort.
Then it sent four short questions at medium, low, high and medium effort with `bb thread tell --reasoning-level`.

| Turn | Effort | First request: cache read | First request: cache write | Turn cost |
| --- | --- | --- | --- | --- |
| 1 | medium | 15,652 | 27,133 | $0.769 |
| 2 | medium | 107,249 | 53 | $0.024 |
| 3 | low | 107,302 | 141 | $0.024 |
| 4 | high | 107,443 | 3,826 | $0.053 |
| 5 | medium | 111,269 | 112 | $0.025 |

An effort change does not rewrite the cached context.
After each change, the next request still read the whole context from cache.
The change to high effort wrote 3.8k tokens once, which cost about $0.03.

## Live test

The control build had WP4 and WP5, and the WP2 build added this change.
Model Pilot can run only one build at a time.
So the two arms ran one after the other on October 19, 2026, about one hour apart.
Each arm ran the 4 multi-turn tasks and the coupon task.
One Opus judge per task rated both answers blind.

| Task | Control | WP2 build | Later efforts on the WP2 build | Control good enough | WP2 good enough | Better |
| --- | --- | --- | --- | --- | --- | --- |
| m1 CDN publish | $0.33 | $0.29 | low, low | yes | yes | WP2 |
| m2 Document Editor reload | $0.22 | $0.25 | low, low | yes | yes | WP2 |
| m3 AX evaluation project | $0.50 | $0.51 | low, high | yes | yes | control |
| m4 1.23.0 release freeze | $1.46 | $0.95 | low, low | yes | yes | control |
| coupon | $1.18 | $0.87 | one message | yes | yes | tie |
| Total of m1 to m4 | $2.51 | $2.00 | | 4 of 4 | 4 of 4 | |

The control build kept the first prompt's effort on every later message: medium on m1 to m3 and high on m4.

The 20% drop in the total is not all due to this change.
Most of the m4 difference comes from the helpers of its first message, which cost $0.89 on the control and $0.27 on the WP2 build.
The first message is routed the same way on both builds, so that difference is noise.
The coupon task has one message, so this change cannot affect it.

The part that this change affects is the main agent's second and third messages.
`turn_cost.py` prices each run by user message.

| Main agent, by message | Control | WP2 build |
| --- | --- | --- |
| First message, m1 to m4 | $1.06 | $1.37 |
| Second message, m1 to m4 | $0.33 | $0.19 |
| Third message, m1 to m4 | $0.24 | $0.17 |
| Second and third messages | $0.57 | $0.36 |

The second and third messages cost 37% less on the WP2 build.
The judge preferred the WP2 build on 2 tasks and the control on 2, and called the coupon task a tie.

## Limits

The two arms did not run at the same time.
A second Model Pilot install needs the classifier key, and the session was not allowed to set a secret.
The m tasks read live repositories and Linear, which can change between two runs.
Five tasks are a small sample.
A message cost depends on how long the agent works, and that varies between runs.

## Cost of this step

The cache test cost $0.89.
The control arm cost $3.70, and the WP2 arm cost $2.86.
The 10 judges cost $1.01.
A first control run cost $3.35 before it was stopped, because the runner sent the next message while background helpers were still working.
The step cost $11.81 in total.
