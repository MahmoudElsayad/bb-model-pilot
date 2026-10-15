---
name: auto-router
description: Use when explaining or operating Model Pilot in BB, including classifier connections, automatic model selection, helpers, routed plans, and usage history.
---

# Model Pilot in BB

Model Pilot is the display name of the installed `auto-router` plugin.
The provider identifier remains `auto`, and the commands remain under `bb auto`.
The tools remain `auto_plan`, `auto_step_done`, and `auto_delegate`.
Use those identifiers when operating the plugin.

## Connect and explain

Open Model Pilot in the BB navigation.
The normal setup uses BB's available Codex and Claude Code models for classification.
The classifier is the model that chooses how the task runs.
If a connection already exists, select Change connection.
Choose a Classification model and select Connect and test.
Native classification uses the installed Codex or Claude Code command-line program with the existing provider sign-in.
It needs no separate API key.
Provider subscription limits, model access, and quota still apply.
BB's model catalog is not an account entitlement guarantee.

The native classifier uses a separate temporary directory and restricted tool access.
The plugin removes that directory after the request.
A crash can interrupt cleanup.
Provider retention follows the provider's own policy.

Legacy API modes remain available through BB plugin settings.
Jev uses a separate TypeSafe API key.
Direct OpenAI and Anthropic API modes also need separate API keys and API credit.
Do not claim that a coding subscription supplies credit for those API modes.
The page never returns a saved key.
Never request or print a credential in chat, task text, logs, screenshots, or command arguments.

Existing Jev configuration can use `JEV_API_KEY` or an explicitly configured 1Password reference.
Do not replace an existing working connection without an instruction to change it.
If a connection fails, explain the provider error without disclosing secrets.
Distinguish missing CLI login, insufficient quota, offline host, unsupported model, and an invalid optional API key.

## Route work

Select Model Pilot when creating a BB thread.
The classifier chooses the main model, reasoning effort, and context window from the first message.
Later messages keep that main model and session.
The classifier then chooses direct work, a helper, or a routed plan.
A helper starts with a new context.

Use `auto_plan`, `auto_step_done`, and `auto_delegate` when the routing instruction requests them.
Give each helper the full task, file paths, facts, and expected result that it needs.
Follow plan dependencies before starting each step.
The main agent remains responsible for the final result.
Helpers inherit the parent's permission mode.

Jev retains the original TypeSafe classification policy.
Other classifiers return choices for the same routing categories.
Do not describe those choices as Jev's calibrated probabilities or claim equivalent decision quality.
If classification fails, the policy can use an Opus medium fallback.
Explain that the fallback can cost more and still needs native provider access.

## Explain usage and privacy

Open Usage for recorded tokens, cost trends, model shares, helpers, classifier overhead, and recent threads.
A cost baseline applies another model's price to the same recorded agent tokens.
It does not measure token savings, actual provider bills, or equivalent task quality.
Unknown prices suppress the savings estimate.
Classifier rates use the bundled snapshot for known models.
Unknown models or missing usage leave classifier cost unknown.
Native classifier cost is unknown in this release, so its savings estimate stays hidden.
Recorded classifier input and output tokens remain visible when available.

The selected classifier receives task text, routing questions, and relevant plan text or helper briefs.
The selected coding agent receives its task through BB's existing provider integration.
Native provider sign-ins follow BB and the installed provider CLI.
Optional API keys use BB secret storage and private host files with `0600` permissions.
Usage history is limited, so displayed totals can exclude older work.
Use the Guide tab or README for detailed setup, estimates, and troubleshooting.

## Inspect and respect compatibility

Run `bb auto --help` for installed commands.
Use `bb auto route` to preview a classification without starting a coding agent.
The preview consumes usage through the selected classifier.
Use `bb auto status --thread <thread-id>` to inspect a thread's routing records.

This integration supports BB 0.46 on macOS and uses its bundled Codex and Claude bridges.
If a BB update changes the bridge protocol, update the adapter before relying on it.
Do not claim support for other hosts or versions without real installation evidence.
Read `PUBLIC-RELEASE.md` before preparing a public artifact.
