#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runPlacementShadowGraph, type PlacementGraphInput } from '../src/guardian/placement-shadow.js';

const inputFile = process.argv[2];
if (!inputFile) {
  console.error('usage: bun scripts/guardian-placement-shadow.ts <snapshot-and-cio-input.json>');
  process.exitCode = 2;
} else {
  try {
    const input = JSON.parse(readFileSync(resolve(inputFile), 'utf8')) as PlacementGraphInput;
    if (!input || typeof input !== 'object' || !input.snapshot || typeof input.cioHost !== 'string')
      throw new Error('input JSON must contain snapshot and cioHost');
    const state = await runPlacementShadowGraph(input);
    console.log(JSON.stringify({ graphId: state.graphId, runId: state.runId, status: state.status,
      path: state.path, shadow: state.nodes.find(node => node.nodeId === 'placement-compare')?.output ?? null }));
    if (state.status !== 'done') process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
