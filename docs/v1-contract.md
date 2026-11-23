# RayTrace `/v1` API Contract (Frozen v1.0)

This contract defines the stable HTTP surface consumed by `@raytrace-cli/sdk` (TypeScript), `raytrace-sdk` (Python, imported as `raytrace_sdk`), the CLI, and the MCP server.

## Authentication

Send `Authorization: Bearer <token>` on every request:
- **Org API key:** `rtk_<token>` (created via `POST /v1/api-keys`, hashed at rest with SHA-256, scoped to one organization, never instance-admin).
- **User session:** WorkOS RS256 access token from `raytrace auth login`.

## Standard Error Shape

All non-2xx responses return JSON:

```json
{ "error": "Human-readable message", "code": "optional_machine_code" }
```

| HTTP | `code` | Meaning |
|---|---|---|
| `400` | — | Invalid input or sandbox state (e.g. stopped sandbox on `shell`) |
| `401` | — | Missing, expired, or revoked credentials |
| `402` | `insufficient_balance` | Wallet cannot cover one 15-minute block (`topup_url`, `balance_micros`, `required_micros` included) |
| `402` | `recording_plan_required` | Active Individual or Team recording plan required (`checkout_path`, `topup_url` included) |
| `403` | — | Authenticated caller lacks org-admin permission |
| `404` | — | Resource does not exist or belongs to another org |
| `429` | — | Concurrent command limit reached (4 active commands per sandbox) |
| `503` | `no_capacity` | Host CPU/RAM/disk admission limit reached (retryable) |
| `503` | `creation_unavailable` | Cloud creation switched off or host release mismatch |

## Endpoints

### Sandboxes

| Method & Path | Headers / Body | Response |
|---|---|---|
| `GET /v1/sandboxes` | — | `200 SandboxSummary[]` |
| `POST /v1/sandboxes` | Headers: `X-RayTrace-Name`, `X-RayTrace-Size` (`small\|medium\|large`, default `small`), optional `Idempotency-Key`. Body: `.tar.gz` project archive (≤100 MiB) | `201 SandboxSummary & { run_id, paid_until }` |
| `POST /v1/sandboxes/{id}/start` | Optional JSON `{ "size"?: "small\|medium\|large" }` | `200 { id, status: "running", size, run_id, paid_until, restored_from_archive }` or `202 { id, status: "starting", restoring: true, size, run_id, paid_until }` |
| `POST /v1/sandboxes/{id}/stop` | — | `200 { id, status: "exited" }` |
| `POST /v1/sandboxes/{id}/keep-alive` | JSON `{ "minutes": 0..240 }` | `200 ActivityState` |
| `DELETE /v1/sandboxes/{id}?keep_traces=0\|1` | — | `200 { id, status: "deleted", ... }` |
| `GET /v1/sandboxes/{id}/repos` | — | `200 { id, repos: string[] }`: the GitHub repositories (`owner/name`) its git may open |
| `PUT /v1/sandboxes/{id}/repos` | JSON `{ "repos": string[] }`, at most 20, replacing the list; each one the org's RayTrace GitHub App is installed on | `200 { id, repos }`; `400` naming the repository that cannot be attached |

### Commands

| Method & Path | Body | Response |
|---|---|---|
| `POST /v1/sandboxes/{id}/commands` | JSON `{ "command": string, "timeout_seconds"?: 1..1800, "request_id": string }` | `202 CommandJob` |
| `GET /v1/sandboxes/{id}/commands/{cmd_id}` | — | `200 CommandJob` (`state`: `queued \| running \| completed \| cancelled \| timed_out \| interrupted`, `exit_code`, `stdout`, `stderr`) |
| `POST /v1/sandboxes/{id}/commands/{cmd_id}/cancel` | — | `200 CommandJob` |

### Usage & Billing

| Method & Path | Query / Body | Response |
|---|---|---|
| `GET /v1/usage?days=30` | `days`: `1..90` | `200 UsageSummary` (`wallet`, `burn_rate_usd_per_hour`, `running_sandboxes`, `blocks_this_month`, `spend_this_month_usd`, `spend_by_sandbox`, `spend_by_day`, `runs`, `archives`, `ledger`) |
| `POST /v1/billing/topup` | JSON `{ "amount_usd": number }` (≥ `$5`) | `200 { "url": "https://checkout.stripe.com/..." }` |

### Org API Keys (Org Admins)

| Method & Path | Body | Response |
|---|---|---|
| `GET /v1/api-keys` | — | `200 { "keys": ApiKeySummary[] }` |
| `POST /v1/api-keys` | JSON `{ "name": string }` | `201 { id, org_id, name, prefix, key, created }` (`key` returned once) |
| `DELETE /v1/api-keys/{key_id}` | — | `200 { id, revoked: true }` |
