#!/usr/bin/env bun
/** Drain the coordinator inbox once without running the orchestrator graph. */
import { runCoordinatorInboxOnce, type InboxOnceOptions } from '../src/loops/orchestrator/inbox-once.js';

export function runAskOpInboxCli(options: InboxOnceOptions = {}) {
  return runCoordinatorInboxOnce(options);
}

if (import.meta.main) {
  try {
    const result = await runAskOpInboxCli();
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`coordinator inbox: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
