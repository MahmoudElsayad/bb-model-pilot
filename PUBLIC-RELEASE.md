# Model Pilot 0.4.0 release notes and requirements

Model Pilot is an experimental BB plugin for AI model routing, coding agents, and usage reporting.
The public source is [MahmoudElsayad/bb-model-pilot](https://github.com/MahmoudElsayad/bb-model-pilot).
Original plugin code uses the MIT license with copyright 2026 Mahmoud Elsayad.
Copied T3 Code portions retain the MIT notice in `notices/T3-CODE-LICENSE.txt`.

## Installation and marketplace status

The Git release source is `git:https://github.com/MahmoudElsayad/bb-model-pilot.git@^0.4.0`.
The plugin identifier remains `auto-router`, and the provider identifier remains `auto`.
Commands remain under `bb auto`.
The display name is Model Pilot.

The BB Community marketplace submission is pending.
A submission does not make the plugin discoverable in the marketplace until its maintainers merge it.
Direct Git installation uses the public tagged release independently of that review.
The primary category is `agents-and-providers`.
The secondary category is `token-usage-and-limits`.

## Compatibility limits

Version 0.4.0 targets BB 0.46 on macOS, bridge protocol 2, and grammar version 3.
The adapter uses internal BB bridge files rather than a public reusable provider factory.
A BB update can require an adapter update.
Other platforms and BB versions do not have verified support.
Model availability depends on each user's provider accounts.
Test each supported BB release before expanding the compatibility range.

## Accounts and payment

Users choose a classifier from BB's available Codex and Claude Code models.
Native classification uses the existing provider sign-in without a separate API key.
Provider subscription limits and model access still apply.
The model picker reads BB's provider catalog, not an account entitlement guarantee.

Existing Jev configuration remains an advanced mode through BB plugin settings with a separate TypeSafe API key.
Legacy direct OpenAI and Anthropic API modes also require separate keys and billing.
The plugin includes no extra credits, shared account, payment collection, or hosted inference service.
Users pay their providers directly.
The open-source license permits commercial use under its terms.
BB marketplace checkout is not part of this release.

## Classifier and usage limits

Jev retains the original TypeSafe classification policy.
Other classifiers return choices for the routing categories.
Adapter compatibility does not establish equivalent decision quality.
A failed classification can trigger the policy's Opus medium fallback.
That fallback requires provider access and can cost more than the expected route.

Usage reports recorded tokens and estimated prices.
The baseline comparison applies another model's price to the same recorded agent tokens.
It does not measure token savings, task quality, or actual provider charges.
Unknown model prices or classifier usage suppress the savings estimate.
Native classifier cost remains unknown in this release.
Bundled rates are dated snapshots, not live pricing.
Read the README for the price sources and report retention limits.
Read [PRIVACY.md](PRIVACY.md) for records, credentials, retention, and removal limits.

## Release requirements

1. Make sure that the release contains no keys, private recordings, personal vault references, or runtime records.
2. Preserve the MIT license and all upstream notices.
3. Keep the seven-day package cooldown and use the committed dependency lockfile.
4. Run automated tests, type analysis, and the plugin build.
5. Test a clean installation from the exact tagged Git artifact.
6. Make sure that the package builds with the dependencies that Git installation supplies.
7. Test the real connection page, scrolling, navigation, and usage charts.
8. Record which classifiers completed live requests and which only passed adapter tests.
9. Make sure that marketplace metadata preserves the compatibility, account, and estimate limits.
10. Run the marketplace source and schema tests before submission.

A passing unit suite does not establish live access to every advertised model.
A local path installation does not establish that the public Git artifact installs successfully.
The release record must distinguish completed tests from untested account or platform combinations.
