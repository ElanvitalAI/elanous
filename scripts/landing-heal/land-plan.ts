#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { planTrain, type TrainCandidate, type TrainDeferred } from '../../src/self-implement/merge-train.js';
import type { L8ShadowQueueState } from '../../src/self-implement/l8-merge-queue.js';

export const LAND_PLAN_MAX_BATCH = 8;

type LandPlan = { batch: TrainCandidate[]; deferred: TrainDeferred[] };

function inputPath(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== '--input') throw new Error('usage: land-plan.ts --input <absolute-json-path>');
  const path = args[1];
  if (!path || !isAbsolute(path)) throw new Error('--input requires an absolute path');
  if (!existsSync(path)) throw new Error('input file missing');
  return path;
}

function isQueueState(value: unknown): value is L8ShadowQueueState {
  if (!value || typeof value !== 'object' || !('pending' in value) || !Array.isArray(value.pending)
    || !value.pending.every((item) => item && typeof item === 'object'
      && Number.isSafeInteger(item.number) && item.number > 0
      && typeof item.head === 'string' && /^[0-9a-f]{40}$/i.test(item.head)
      && (item.files === undefined || Array.isArray(item.files) && item.files.every((file: unknown) => typeof file === 'string'))
      && (item.filesUnmeasured === undefined || item.filesUnmeasured === true))
    || !('verdicts' in value) || !Array.isArray(value.verdicts)
    || !('deferred' in value ? Array.isArray(value.deferred) : true)) return false;
  return true;
}

function candidates(state: L8ShadowQueueState): TrainCandidate[] {
  return state.pending.map(({ number, head, files, filesUnmeasured }) => ({
    number,
    head,
    ...(files === undefined ? {} : { files }),
    ...(filesUnmeasured === undefined ? {} : { filesUnmeasured }),
  }));
}

export function planLandQueue(state: unknown): LandPlan {
  if (!isQueueState(state)) throw new Error('invalid shadow queue ledger');
  return planTrain(candidates(state), { maxBatch: LAND_PLAN_MAX_BATCH });
}

export function runLandPlan(args: readonly string[]): LandPlan {
  const state: unknown = JSON.parse(readFileSync(inputPath(args), 'utf8'));
  return planLandQueue(state);
}

if (import.meta.main) {
  try {
    process.stdout.write(`${JSON.stringify(runLandPlan(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
