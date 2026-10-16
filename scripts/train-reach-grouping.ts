#!/usr/bin/env bun
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { buildTrainReachDecision, type TrainReachInput } from '../src/self-implement/train-reach-grouping.js';
import { buildTrainScenarioDecision, readTrainTestPopulation, type TrainRiskEvidence } from '../src/self-implement/train-scenario-layers.js';

type ScenarioInput = TrainReachInput & { riskEvidence?: TrainRiskEvidence };

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || !value || value.startsWith('--') || !isAbsolute(value)) throw new Error(`${name} requires an absolute path`);
  return value;
}

let temporary = '';
let outputPath = '';
let protectsInput = false;
try {
  if (process.argv.length !== 6) throw new Error('usage: train-reach-grouping.ts --input <absolute> --output <absolute>');
  const inputPath = option('--input');
  outputPath = option('--output');
  if (!existsSync(inputPath)) throw new Error('input file missing');
  protectsInput = resolve(inputPath) === resolve(outputPath)
    || (existsSync(outputPath) && realpathSync(inputPath) === realpathSync(outputPath));
  if (protectsInput) throw new Error('input and output paths must differ');
  const input = JSON.parse(readFileSync(inputPath, 'utf8')) as ScenarioInput;
  const reach = buildTrainReachDecision(input);
  const scenario = input.riskEvidence === undefined ? undefined : (() => {
    if (input.prs.length === 0) throw new Error('scenario has no PR tree for pinned population');
    const baseTests = readTrainTestPopulation(input.prs[0]!.tree, input.baseSha);
    const headTests = input.prs.map((candidate) => new Set(readTrainTestPopulation(candidate.tree, candidate.headSha)));
    const survivingTests = baseTests.filter((test) => headTests.every((present) => present.has(test)));
    return buildTrainScenarioDecision(input, reach, survivingTests, input.riskEvidence!);
  })();
  const result = scenario ? { ...reach, scenario, parallelSafe: scenario.parallelSafe } : reach;
  temporary = `${outputPath}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  renameSync(temporary, outputPath);
  temporary = '';
  if (!result.parallelSafe) process.exitCode = 2;
} catch (error) {
  if (outputPath && !protectsInput) rmSync(outputPath, { force: true }); // never reuse a previous decision after failure
  console.error(`train reach unmeasured: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
} finally {
  if (temporary) rmSync(temporary, { force: true });
}
