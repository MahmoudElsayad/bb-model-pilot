# Privacy and local data

Model Pilot routes tasks through providers that you choose.
The plugin does not operate a hosted inference service or collect payments.
Your classifier provider and coding providers process requests under their own terms.

## Data sent to providers

The classifier receives task text and routing questions.
Requests can include plan text and helper briefs.
The current routing text limit is 12,000 characters.
A connection test sends a small test request to the selected provider.
Native classification uses the installed Codex or Claude Code command-line program with your existing sign-in.
It requests classification in a separate temporary directory with restricted tool access.
Provider instructions and skill metadata can still enter the classifier context.
The plugin removes that temporary directory after the request.
A crash can interrupt cleanup, and provider-side retention follows the provider's own policy.
The selected Codex or Claude Code agent receives its task through BB's existing provider integration.
Its own tools can read workspace data according to BB's granted permissions.

Jev uses TypeSafe.
The OpenAI and Anthropic adapters use fixed official API endpoints.
The plugin does not accept custom classifier endpoint URLs.
Review provider retention policies before you send confidential work.

## Keys and connection details

BB manages native provider sign-ins.
Native BB classification does not require a separate API key.
The following credential files apply to optional API classifier modes.
BB stores their API keys in secret plugin settings.
The plugin provisions a copy to its execution host for classification requests.
Host files use owner-only permissions, `0600`.
This is a file permission restriction, not a claim of encrypted host files.
The page receives status rather than a saved key.
The plugin does not place the key in task history or logged provider environment values.

The host credential filenames are `jev-credential`, `jev-credential.openai`, and `jev-credential.anthropic`.
The host also stores the classifier selection in `jev-credential.configuration`.
An optional Jev reference uses `jev-credential.op-reference`.
The default local plugin directory is `~/.bb/plugins/auto-router/`.
Host layout can differ when BB runs the plugin on another host.
An environment variable or a configured 1Password reference can supply an existing Jev credential instead.

## Local records and retention

Host session metadata includes BB and native session identifiers, the selected route, delegation, revision, helper status, timestamps, and turn count.
The host stores metadata and an event ledger under the plugin's `bridge-data/sessions/` directory.
Session files use `.json` and ledger files use `.ndjson`.
The native provider adapter also uses the plugin's `bridge-data/native/` directory.
Provider session storage follows BB and the native provider's behavior.

Ledger events include route decisions, plan or delegation activity, and usage records.
The dashboard reads at most 100 records per session, 500 sessions, and 5,000 records per report.
These are reporting limits, not an automatic expiration date for all stored files.
When a ledger exceeds 2 MB, its next write keeps the latest 100 records before it appends another record.
Session metadata does not have a time-based expiration.

BB plugin storage retains plans, plan routing results, CLI previews, and plan usage history.
Plan usage history keeps its latest 100 records per thread.
Plan text can contain task details and private file paths.
The plugin does not set a time-based expiration for those records.
BB separately retains coding conversations and helper threads according to its own storage behavior.
Archived helper threads are not a guarantee of deleted conversations.

## Revoke access and remove data

If a key is exposed, revoke it in that provider's console first.
Clear its corresponding API key field in BB's plugin settings.
Remove any optional Jev 1Password reference or `JEV_API_KEY` environment variable that you supplied.
Restart the affected BB host after you change environment credentials.
The Connection page does not currently include a Disconnect or Delete history action.

Stop Model Pilot threads before you remove host files.
Close BB before you remove local runtime data.
Locate the `auto-router` plugin data on each affected host.
Remove only the credential files, session files, and native runtime files described above that you intend to delete.
Deleting session metadata prevents Model Pilot from resuming those sessions.
Do not assume that uninstalling the plugin deletes credentials, plugin storage, native sessions, or BB conversations.

Use BB's data management controls for stored conversations and plugin records where available.
BB owns its plugin storage database, so this project does not provide a command that edits that database directly.
For sensitive workloads, treat full deletion as a manual host and BB storage audit.
Do not send the contents of credential files or private records in a public issue.
