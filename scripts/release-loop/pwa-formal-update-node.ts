#!/usr/bin/env bun
import { errorResult, finishNode, readGraphContext } from './node-verdict.js';
import { runPwaFormalUpdateNode } from './pwa-formal-update.js';

export async function runPwaFormalUpdateGraphNode(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let node = 'pwa-formal-update';
  let version = '';
  try {
    const context = readGraphContext(env);
    node = context.nodeId;
    version = context.input.version;
    if (node !== 'pwa-formal-update') throw new Error(`PWA update node context mismatch: ${node}`);
    return finishNode(node, version, await runPwaFormalUpdateNode());
  } catch (error) {
    return finishNode(node, version, errorResult(error));
  }
}

if (import.meta.main) process.exitCode = await runPwaFormalUpdateGraphNode();
