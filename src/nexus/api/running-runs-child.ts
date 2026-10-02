#!/usr/bin/env bun
// Child of running-runs-background.ts: runs the running-runs query (all the ledger I/O) and prints the result as JSON.
import { queryRunningRuns } from '../../self-implement/running-runs.js';

const result = queryRunningRuns({ includeTest: process.argv.includes('--include-test'), caller: 'nexus.terminals' });
process.stdout.write(JSON.stringify(result));
