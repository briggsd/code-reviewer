# Observability

How to get review telemetry out of the runner and into your own logging/observability
stack — Grafana Loki, Datadog, or any authenticated HTTP collector.

This is the **adopter setup guide**. For the event schema, the counts-only privacy boundary,
and the `telemetry:rollup` / `telemetry:analyze` / `telemetry:quality` analysis tooling, see the
developer reference: [Telemetry export](../developer/telemetry-export.md).

## What you get

Every review run emits structured telemetry — a durable `telemetry.jsonl` artifact (always,
under `--output-dir`) plus, when you configure a remote exporter, a mirror of each event to your
collector. The events are **counts and identifiers only** — no PR/MR content, finding text,
prompts, or author names ever leave the runner (the M008 egress boundary; see the developer
reference). Concretely you get, per run: risk tier, decision/outcome, finding counts by severity
and reviewer, duration, token/cost metrics, new/recurring/fixed counts across re-review rounds,
and break-glass override events. That is enough to build dashboards for review volume, block
rate, cost per tier, and the override rate (the headline "is the bot misfiring" signal).

Remote export is **default-off**: with no exporter env var set, behavior is byte-identical to
today and nothing leaves your CI.

## 1. Pick an exporter

Each exporter owns an env namespace. Setting its `_URL` (or, for Datadog, `_API_KEY`) enables it.

| Exporter | Enable with | Auth |
| --- | --- | --- |
| **Generic HTTP** | `AI_REVIEW_TELEMETRY_URL` — any `http(s)` collector; events POST as newline-delimited JSON | `AI_REVIEW_TELEMETRY_AUTHORIZATION` (raw `Authorization` header) or `AI_REVIEW_TELEMETRY_BASIC_AUTH` (`user:token`) |
| **Grafana Loki** | `AI_REVIEW_LOKI_URL` — base Loki URL (e.g. `https://logs-prod-012.grafana.net`); `/loki/api/v1/push` is appended | `AI_REVIEW_LOKI_AUTHORIZATION` or `AI_REVIEW_LOKI_BASIC_AUTH` (Grafana Cloud: `<instance-id>:<api-token>`) |
| **Datadog** | `AI_REVIEW_DATADOG_URL` — base logs-intake host for **your site** (see below); `/api/v2/logs` is appended | `AI_REVIEW_DATADOG_API_KEY` — sent as the `DD-API-KEY` header |

**Datadog site matters.** The intake host is site-specific — use the one for the account your API
key belongs to, or the key is rejected:

| Site | `AI_REVIEW_DATADOG_URL` |
| --- | --- |
| US1 | `https://http-intake.logs.datadoghq.com` |
| US3 | `https://http-intake.logs.us3.datadoghq.com` |
| US5 | `https://http-intake.logs.us5.datadoghq.com` |
| EU1 | `https://http-intake.logs.datadoghq.eu` |
| AP1 | `https://http-intake.logs.ap1.datadoghq.com` |

Optional: `AI_REVIEW_DATADOG_SERVICE` overrides the `service` field/tag (default
`ai-code-review`). Datadog **metrics** intake is not supported — derive metrics from the logs with
a Datadog log pipeline.

> **Requires v0.5.0+.** The Datadog exporter and its `DD-API-KEY` header support shipped in
> 0.5.0. On an older runner, `AI_REVIEW_DATADOG_*` is silently ignored. Check your
> `AI_REVIEW_PACKAGE` pin (GitLab) or the wrapper version (GitHub) points at 0.5.0 or later.

## 2. Only one remote exporter runs per review

If more than one exporter is configured, **exactly one is selected** — precedence is
**Loki → Datadog → generic**. This is not a fan-out: a configured Loki *shadows* a configured
Datadog, and Datadog gets nothing with no error. If you are switching from Loki to Datadog,
**unset the `AI_REVIEW_LOKI_*` variables** — don't just add the Datadog ones.

The durable local `telemetry.jsonl` is always written regardless; the remote is a mirror of it.

## 3. Wire it into CI

Remote export only fires on the **real review** path (the `pi` runtime, run with `--output-dir`).
The dry-run / dummy jobs emit no remote telemetry. So set the exporter variables on your
real-review job.

### GitHub Actions

GitHub does **not** auto-inject secrets/variables into a job — each must be explicitly forwarded
in the job's `env:` block, or the runner never sees it. Mirror the Loki lines already present in
`ai-review.yml`'s real-review job:

```yaml
    env:
      # … existing AI_REVIEW_GITHUB_TOKEN / ANTHROPIC_API_KEY / etc …
      AI_REVIEW_DATADOG_URL: ${{ vars.AI_REVIEW_DATADOG_URL }}
      AI_REVIEW_DATADOG_API_KEY: ${{ secrets.AI_REVIEW_DATADOG_API_KEY }}
```

- The **API key must be a repository/organization secret** (`secrets.*`) — it is a credential.
- The **URL is not sensitive** and can be a repository variable (`vars.*`).
- Setting the secret/variable in the repo settings is necessary but **not sufficient** — the
  `env:` forwarding line is what actually delivers it to the process.

### GitLab CI

GitLab is the opposite: **project CI/CD variables are automatically exposed to every job's
environment**. So you generally do **not** need to touch `.gitlab-ci.yml` — just define the
variables in **Settings → CI/CD → Variables** and the runner picks them up:

- `AI_REVIEW_DATADOG_API_KEY` — mark it **Masked** (and **Protected** if your real-review job runs
  only on protected branches). It is a credential.
- `AI_REVIEW_DATADOG_URL` — a plain variable is fine.

Two GitLab-specific caveats:

- **Protected variables only appear on protected refs.** If you mask/protect the API key, make
  sure the real-review job runs on a ref that receives it, or the exporter sees no key and throws
  at startup.
- **Check your `AI_REVIEW_PACKAGE` version.** The `examples/ci/` GitLab templates pin the runner
  package version; it must be **0.5.0 or later** for the Datadog exporter to exist.

## 4. Verify it works

Trigger a real review and check delivery two ways:

1. **The run trace.** Under `--output-dir`, `runs/<runId>/trace.jsonl` records a
   `telemetry.remote_delivered` event per delivered telemetry event (with `errorName: null` on
   success). A `telemetry.remote_delivery_failed` event means the POST was rejected — check the
   URL/site and the key.
2. **Your collector.** In Datadog's Logs Explorer, filter `service:ai-code-review`; in Loki, query
   `{service="ai-code-review"}`. A run emits a handful of events (`run.start`, `run.completed`,
   and the `run_metrics` summary).

A 2xx from the collector's intake means the payload was **accepted** — for full confidence that
it landed and indexed, confirm it appears in your collector's UI.

## Startup errors (fail-fast)

Misconfiguration is caught at startup, before any review runs, rather than failing silently:

- A configured `_URL` that is not a valid `http(s)` URL, or that targets a cloud metadata
  endpoint, is rejected.
- **Datadog:** `AI_REVIEW_DATADOG_URL` set without `AI_REVIEW_DATADOG_API_KEY` is an error; so is
  a plaintext `http://` intake URL while a key is present (the key must never cross the wire in
  plaintext).
- A credential over plaintext `http://` (via `_AUTHORIZATION`/`_BASIC_AUTH` or embedded in the
  URL) is refused — use `https://`.

## What is *not* exported

By design, the remote payload carries **no** PR/MR titles or descriptions, comment text, diffs,
finding text, prompts, model output, author names, or branch names. Override events carry a stable
comment id and a coarse role category (`OWNER`/`MEMBER`/`COLLABORATOR`), never an identity. See
[Telemetry export → counts-only constraint](../developer/telemetry-export.md) for the full
boundary and how to analyze the exported stream.
