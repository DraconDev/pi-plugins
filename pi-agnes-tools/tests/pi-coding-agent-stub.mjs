/**
 * Minimal @earendil-works/pi-coding-agent stub for tests.
 * Provides getAgentDir() returning an in-memory path that does not exist,
 * so loadConfigFor() falls back to defaults and file writes are no-ops.
 */
export function getAgentDir() {
  return "/tmp/pi-model-filter-test-agent-dir-" + process.pid;
}

export const VERSION = "0.0.0-test";
