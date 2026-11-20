#!/usr/bin/env bun
// RELEASE-TRAFFIC-PREP-T1H — release graph node `traffic-prep` (entry, before cut-branch). Plugin command bindings
// take one argument-free `<name>-node.ts` entry per node, so this file only dispatches to traffic-node.ts.
import { runTrafficPrepNode } from './traffic-node.js';

if (import.meta.main) process.exitCode = await runTrafficPrepNode();
