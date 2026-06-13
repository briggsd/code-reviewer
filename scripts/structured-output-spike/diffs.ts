/**
 * Spike test diffs for M015 S01 (#124) — measure the instruct-only hit-rate of the
 * `submit_findings` structured-output tool on diffs that have crashed the prose path.
 *
 * The first two cases reproduce the exact token patterns that crashed the heuristic
 * quote-repair path (#119 prose quote-list inside an object string value; #120 / TS-type-token
 * density). They are designed to ELICIT findings whose natural phrasing reuses those adversarial
 * tokens, so we test whether the structured path delivers them cleanly where the prose path
 * corrupted them. The remaining cases are ordinary review situations (a real bug, a perf issue,
 * and a clean diff that should still produce an empty-findings tool call).
 */

export interface SpikeCase {
  /** Stable id for the report. */
  readonly id: string;
  /** Reviewer role to play (mirrors a TRUSTED_REVIEWER_DEFINITIONS role). */
  readonly reviewer: string;
  /** One-line human description of what this case stresses. */
  readonly note: string;
  /** PR title shown to the reviewer. */
  readonly title: string;
  /** Unified-diff patch the reviewer reviews. */
  readonly patch: string;
}

export const SPIKE_CASES: readonly SpikeCase[] = [
  {
    id: "compare-status-quote-list",
    reviewer: "correctness",
    note: '#119 trigger: review naturally quotes "ahead", "behind", "diverged" in a finding body',
    title: "Handle GitHub compare statuses in re-review ancestry check",
    patch: `--- a/src/vcs/github/compare.ts
+++ b/src/vcs/github/compare.ts
@@ -10,7 +10,12 @@ export async function isAncestor(base: string, head: string): Promise<boolean> {
   const res = await api.compareCommits(base, head);
-  return res.status === "ahead";
+  // status is one of: ahead, behind, diverged, identical
+  if (res.status === "ahead" || res.status === "identical") {
+    return true;
+  }
+  // behind and diverged both mean the base moved; treat as ancestor anyway
+  return res.status === "behind" || res.status === "diverged";
 }
`,
  },
  {
    id: "finding-array-ts-tokens",
    reviewer: "correctness",
    note: "#120 trigger: TS-type-token-dense diff (Finding[], ReviewSummary) the prose path choked on",
    title: "Fuse reviewer findings into a ReviewSummary",
    patch: `--- a/src/runner/fuse.ts
+++ b/src/runner/fuse.ts
@@ -1,8 +1,18 @@
-import type { Finding, ReviewSummary } from "../contracts/review";
+import type { Finding, ReviewSummary, ReviewerRunResult } from "../contracts/review";

-export function fuse(results: ReviewerRunResult[]): ReviewSummary {
-  const findings: Finding[] = results.flatMap((r) => r.findings);
-  return { findings, decision: "approved", title: "ok", body: "", risk: { level: "low" } };
+export function fuse(results: ReviewerRunResult[]): ReviewSummary {
+  const findings: Finding[] = results.flatMap((r: ReviewerRunResult) => r.findings);
+  const decision = findings.length === 0 ? "approved" : "minor_issues";
+  return {
+    findings,
+    decision,
+    title: findings[0].title,
+    body: "",
+    risk: { level: "low" },
+  };
 }
`,
  },
  {
    id: "auth-missing-authz",
    reviewer: "security",
    note: "real security bug: missing authorization check on an account lookup",
    title: "Add account lookup endpoint",
    patch: `--- a/src/api/accounts.ts
+++ b/src/api/accounts.ts
@@ -20,6 +20,11 @@ export async function getAccount(req: Request, res: Response) {
+  const accountId = req.query.accountId as string;
+  // look up and return the account
+  const account = await db.accounts.findById(accountId);
+  return res.json(account);
 }
`,
  },
  {
    id: "perf-n-plus-one",
    reviewer: "performance",
    note: "real perf issue: N+1 query inside a request loop",
    title: "List orders with their line items",
    patch: `--- a/src/api/orders.ts
+++ b/src/api/orders.ts
@@ -5,6 +5,13 @@ export async function listOrders(userId: string) {
   const orders = await db.orders.findByUser(userId);
+  const result = [];
+  for (const order of orders) {
+    const items = await db.lineItems.findByOrder(order.id);
+    result.push({ ...order, items });
+  }
+  return result;
 }
`,
  },
  {
    id: "clean-diff",
    reviewer: "correctness",
    note: "clean diff: should still call submit_findings with an empty findings array",
    title: "Fix typo in log message",
    patch: `--- a/src/runner/log.ts
+++ b/src/runner/log.ts
@@ -3,5 +3,5 @@ export function logStart(runId: string) {
-  console.info(\`stating run \${runId}\`);
+  console.info(\`starting run \${runId}\`);
 }
`,
  },
];
