/**
 * Terminate the process with the CI decision's exit code.
 *
 * This MUST use `process.exit(code)`, never `process.exitCode = code`. On the
 * partial-timeout path (issue #40 / PR #43 review) the runtime can leave an
 * outstanding child process or handle alive at shutdown — the coordinator
 * subprocess being torn down, plus the un-awaited background `runCoordinator`
 * promise. In that state Bun force-exits with OS status 0 and the *deferred*
 * `process.exitCode` is silently ignored, so a `review_failed` gate would pass
 * green. An explicit `process.exit` delivers the intended status regardless of
 * outstanding handles. Call only after telemetry/trace sinks have flushed.
 */
export function finalizeCiExit(exitCode: number | undefined): void {
  if (exitCode !== undefined) {
    process.exit(exitCode);
  }
}
