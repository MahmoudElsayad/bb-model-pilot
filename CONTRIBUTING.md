# Contribute to Model Pilot

Model Pilot accepts bug reports, documentation improvements, classifier adapters, and tested improvements to AI model routing.
The source uses the MIT license.
Preserve the T3 Code notice for copied code.

## Report a problem

Search existing issues before you open a report.
Include your BB version, operating system, classifier provider, and selected model.
Describe the steps, expected result, actual result, and a minimal example.
Remove API keys, private task text, personal paths, and account details from attachments.
Use [SECURITY.md](SECURITY.md) for vulnerabilities.

## Set up development

Use BB 0.46 on macOS for the current provider adapter.
Install Node.js and pnpm before you start.
Clone the repository and enter its directory.

```sh
git clone https://github.com/MahmoudElsayad/bb-model-pilot.git
cd bb-model-pilot
pnpm install --frozen-lockfile
```

Keep the seven-day minimum package age in the supplied pnpm configuration.
Do not lower or bypass the cooldown to add a dependency.
Use your existing Codex or Claude Code sign-in for native classifier testing.
Use your own API key only when you test an optional API classifier.
Never add credentials or local runtime records to Git.

Run the automated tests and type analysis from the repository root.

```sh
pnpm test
pnpm exec tsc --noEmit
bb plugin build .
```

Install the development directory into BB before you test the interface.
This command installs the local checkout instead of the tagged release.

```sh
bb plugin install .
```

After you change an installed local plugin, build it and reload it.

```sh
bb plugin build .
bb plugin reload auto-router
```

## Prepare a pull request

Explain the user problem and the resulting behavior.
Add a focused test when it can detect the relevant defect.
For interface changes, inspect the real BB page at desktop and narrow widths.
For classifier changes, test errors and explain any change to the routing policy.
Record the commands that you ran and any limits of live testing.

Do not claim lower costs or equivalent routing quality without evidence from completed tasks.
Keep the existing plugin identifier `auto-router` and provider identifier `auto` unless a migration accompanies the change.
Avoid unrelated source formatting and generated output.
Do not include API keys in examples, recordings, fixtures, or logs.

## Release scope

The current adapter uses internal BB provider bridges.
A new BB version needs a clean installation test and live provider testing before support expands.
A passing unit test does not establish compatibility with another BB release.
The marketplace listing remains pending until its maintainers merge the submission.
