# Security policy

The AI Code Review Factory is a security-adjacent tool: it runs in CI, processes
untrusted pull/merge request content, and handles model-provider and VCS credentials.
We take vulnerability reports seriously and welcome responsible disclosure.

## Reporting a vulnerability

**Please report security vulnerabilities privately — do not open a public issue or PR.**

The preferred channel is **GitHub Security Advisories**: open a private report from the
repository's **Security** tab via **"Report a vulnerability"**. This routes the report
privately to the maintainers and gives us a coordinated space to triage, discuss, and
ship a fix before any public disclosure.

If you cannot use GitHub Security Advisories, contact the
`[maintainer security contact — TBD]` (a private channel will be published here once the
project's public home is finalized).

A useful report includes:

- a description of the issue and its impact,
- steps to reproduce (a minimal repro or proof of concept is ideal),
- the affected version/commit, and
- any suggested remediation, if you have one.

## Response posture

- **Acknowledgement:** best-effort, typically within a few business days. This is a
  pre-1.0 project maintained on a best-effort basis — there is no contractual SLA.
- **Coordinated disclosure:** we ask that you give us a reasonable window to investigate
  and release a fix before disclosing publicly. We will keep you informed of progress and
  coordinate timing with you.
- **No bug bounty:** there is currently no paid bug-bounty program. We are happy to credit
  reporters in the advisory unless you prefer to remain anonymous.

## Supported versions

This project is pre-1.0 (`0.x`). Security fixes target the **latest `0.x` release line**
only. There are no long-term-support (LTS) guarantees before `1.0`: older `0.x` releases
do not receive backported fixes, and the public API may change between minor versions.

## Scope and trust model

Before reporting, it helps to understand the trust boundaries the factory is already
designed around — many "issues" are deliberate parts of the security model rather than
defects:

- [Fork safety](docs/user/fork-safety.md) — the CI fork-safety model: untrusted reviewed-repo
  content, secret/write-token handling for fork PRs, trace redaction in CI artifacts, and
  the trusted-operator vs reviewed-repo resource boundary.
- [Decision guardrails](docs/developer/decision-guardrails.md) — load-bearing, shipped invariants
  (egress/telemetry boundary, prompt/trust boundaries, fail-open vs fail-closed policy)
  that are intentional and not to be reverted.

In-scope reports include, for example: bypasses of the egress/telemetry boundary,
ways for untrusted reviewed-repo content to gain trusted-prompt authority or execute in a
privileged CI context, credential or secret exposure, and prompt-injection paths that
defeat the sanitization boundary. Designed-in behaviors documented in the references above
(for example, fail-open being an explicit per-project policy choice) are not vulnerabilities
on their own.
