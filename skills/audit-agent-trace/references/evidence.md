# RayTrace evidence fields

Names below are the ones the CLI and the local API return. Do not invent others. The local API is `http://127.0.0.1:8797` unless `raytrace status` prints another URL (`RAYTACE_PORT` in `~/.raytrace/config.env`). Authorize with `Bearer` and `~/.raytrace/api-token`. Send that token only to that port.

## Trace JSON

`raytrace export <trace-id> --format json` writes:

- `trace.id`, `provider`, `model`, `status`, `title`, `prompt`, `answer`, `started_at`, `ended_at`, `sandbox_id`, `fork_id`
- `trace.requests[]`: `cost`, `input_tokens`, `output_tokens`
- `trace.events[]`: `kind`, `title`, `raw` (a tool call's arguments or output; do not copy output into a report)
- `trace.call_verifications[]`: one proposed tool call, joined to what the sandbox saw

`GET /raytace/traces` returns the latest 10 traces, in camel case (`callVerifications`, `sandboxId`, `startedAt`, `captureHealth`) and the same call objects. `GET /raytace/traces?scope=history` returns the latest 100. `GET /raytace/traces?trace=<id>` is one trace. Those query strings are exact.

A call:

| Field | Meaning |
|---|---|
| `call_id`, `name`, `kind` | `kind` is `command`, `file`, or `agent`. Only `command` starts a program the sandbox can see. |
| `proposed` | The command text, or for a file-write tool the path. |
| `verified`, `kernel_confirmed` | `verified` is false when no process was tied to the call, or the outcome was `not_executed`. `kernel_confirmed` true means gVisor saw the program start. A call can be verified with `kernel_confirmed` false: a weaker match, not a missing command. |
| `exit_code`, `argv`, `status`, `error` | `exit_code` is the sandbox process, not the agent's story. Null when nothing was observed. |
| `reported_check` | `agrees`, `exit_code_differs`, or `duration_differs`. Null when the two cannot be compared. |
| `tier` | `mediated` (the call id was on the process, `RAYTRACE_CALL_ID`), `corroborated`, `inferred` (command text inside a time window), `unverified` (it ran and matched no proposed call). |
| `match_basis` | `id`, `text`, or `window`. |
| `descendants[]` | Child processes of this call (`argv`, `pid`). They are not themselves tool calls. |
| `snapshot.changes[]` | `{ path, status, added, removed }` in the project after the call. |

`tier` on a call is how that call was joined. A process that matched nothing is `unverified`. `attribution: null` on a runtime command means the join is not recorded yet, not that the process was unattributed.

## Search

`GET /raytace/search?q=`. Filters: `outcome` (`failed`, `ok`, `unknown`), `reported`, `observed`, `tool`, `model`, `category`, `kind` (`call`, `turn`, `proxy_error`), `exit` or `exit:>=1`, `file:<substring>`, `after:YYYY-MM-DD`, `before:YYYY-MM-DD`. Bare `failed` means `outcome:failed`. Prefix `-` to negate.

A hit's `turn_id` is the id for `raytrace export` and `raytrace report`. Also `call_id`, `tool_name`, `command_text`, `outcome_reported`, `outcome_observed`, `reported_check`, `exit_code`, `file_paths`. `file_paths` comes from tool arguments and path-like text in commands.

`reported:ok observed:failed` is the agent told it worked and the sandbox saw a failure. `outcome` is `unknown` when there is no result and no observed process. Unknown does not get upgraded to success.

## Activity

`GET /raytace/sandboxes/<rtp-id>/activity` for a local sandbox, while its VM is running. Lists: `files`, `network`, `lookups`, `packages`, `identity`, `bulk`. `more` names lists that were cut off (caps: files 500, network 500, lookups 300, packages 100, identity 100, bulk 100).

Every fact can include `id`, `at` (seconds), `count`, `pid`, `process`, `command` (the command line, cut short), `call_id`, and `coverage: "gaps"` (events were lost around then).

| List | Fields that matter |
|---|---|
| `files` | `path` (null when gVisor did not report the path), `guard` (`restricted`, `watched`, `sensitive`, `project`), `effect`, `certainty`, `intent` on a refusal. |
| `network` | `ip`, `port`, `host` (a best-effort name), `effect` `connect` or `listen`, `outcomes` counts: `connected`, `attempted`, `refused_by_policy`, `failed`, `listening`. |
| `lookups` | `name`, `addresses`, `failed`. |
| `packages` | `manager`, `packages[]` (`name`, `version`), `certainty` `corroborated` (a registry was reached) or `reported` (the manager's records only). |
| `identity` | `effect` `changed` or `attempted`, `ids`. A sandbox should not change uid or gid. |
| `bulk` | `opens`, `folders`. The key `(outside the project)` counts opens whose path was outside `/workspace`. It does not list those paths. |

File `effect`: `read`, `created`, `changed`, `emptied`, `appended`, `deleted`, `renamed`, `permissions_changed`, `attempted`, `opened_for_writing`, `created_and_deleted`, `rewritten`.

`certainty`: `confirmed` (a call was seen and the file shows it), `attempted` (the kernel refused it), `possible` (opened for writing and the file is unchanged), `one_of` (several processes made such a call then), `unattributed` (the file changed and no call was seen).

Reads are stored as file facts for restricted, watched, and sensitive paths. Other reads are counted in `bulk`. Sensitive paths include `.env` other than samples (`example`, `sample`, `template`, `dist`, `defaults`), `.pem`, `.key`, `.p12`, `.pfx`, `keystore`, `id_rsa`, `id_ed25519`, `credentials`, `service-account*.json`, `.npmrc`, `.netrc`, `.pypirc`. The bytes read are not stored.

The initial-scan and alerts APIs are not available for local sandboxes. Locked files are set with `raytrace sandbox files <name> --restrict <path>`.

## Runtime events

`GET /raytace/runtime?sandbox=<rtp-id>&raw=1&since=<ms>&until=<ms>`. `since` and `until` are epoch milliseconds and scope the page to one turn. Without them the response is the sandbox's whole history, newest first.

`raw=1` returns collector events. Kinds used for an audit:

| `kind` | What to read |
|---|---|
| `exec_succeeded` | `argv`, `executable`, `cwd`, `pid` |
| `exec_failed` | `argv`. The program did not start. |
| `process_exit` | `exit_code`, `signal` |
| `open` | `pathname`, `cwd`, `flags`, `errno` |
| `connect` | `ip`, `port`, `family`, `errno`. An address, not a hostname. |
| `listen` | `ip`, `port` |
| `setid` | `ids` |
| `collector_disconnected` | A gap. The stream ended. |

Without `raw=1` the same route returns `commands[]`: `command`, `pid`, `exit_code`, `exec_failed`, `marker_call_id`, `parent_event_id`, `attribution` (`call_id`, `parent_call_id`, `tier`). The response also has `captureHealth`:

- `live`: `reporting`, `catching_up`, `not_reporting`, `ended`, `unknown`, `not_applicable`
- `history`: `no_known_gaps`, `gaps_detected`, `unknown`, `not_applicable`
- `capabilities`: `processes`, `files`, `network` (each true or false)
- `scope` says completeness is not certified

`captureHealth` is on this runtime response and on each trace from `GET /raytace/traces`. It is not a field of `raytrace export`.

## Archive JSONL

`~/.raytrace/archive/<name>-<time>/runtime-evidence.jsonl`, written when a local sandbox is destroyed and its logs are kept. One JSON object per line:

- `table` `capture_streams`: `body.capabilities`, `dropped`, `errors`, `ended_ms`
- `table` `runtime_events`: `kind` plus `body` in the event shape above
- `table` `facts`: `kind` is `file`, `network`, `dns`, `package`, `identity`, or `summary` (those are the activity lists `files`, `network`, `lookups`, `packages`, `identity`, `bulk`). The fact fields are in `body`.

`dns` here is `lookups` on the activity API. `summary` here is `bulk`.
