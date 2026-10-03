import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';

const schema = JSON.parse(readFileSync(resolve(import.meta.dir, 'loop-agent.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateShape = ajv.compile(schema);
const resolutionRank: Record<string, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };

type LoopManifest = {
  id: string;
  grounding: string[];
  posture: { levels: { minResolution: string; maxResolution: string }[] };
  resolution: { steps: { grounding: { tool: string }[] }[] };
  observability: { category: string };
};

/** Run on the complete manifest, including the final result of any overlay merge. */
export function loopAgentContractErrors(input: unknown): string[] {
  if (!validateShape(input)) {
    return (validateShape.errors ?? []).map(error => `${error.instancePath} ${error.message}`);
  }
  const doc = input as LoopManifest;
  const errors: string[] = [];
  if (doc.observability.category !== `loop.${doc.id}`) {
    errors.push('observability.category must equal loop.<id>');
  }
  for (const [index, profile] of doc.posture.levels.entries()) {
    if (resolutionRank[profile.minResolution]! > resolutionRank[profile.maxResolution]!) {
      errors.push(`/posture/levels/${index} resolution bounds reversed`);
    }
  }
  const tools = new Set(doc.grounding);
  for (const [stepIndex, step] of doc.resolution.steps.entries()) {
    for (const [callIndex, call] of step.grounding.entries()) {
      if (!tools.has(call.tool)) {
        errors.push(`/resolution/steps/${stepIndex}/grounding/${callIndex} undeclared grounding tool: ${call.tool}`);
      }
    }
  }
  return errors;
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) {
    console.error('usage: bun src/loops/contract/validate.ts <merged-manifest.yaml|->');
    process.exitCode = 2;
  } else {
    try {
      const errors = loopAgentContractErrors(parseYaml(readFileSync(path === '-' ? 0 : path, 'utf8')));
      if (errors.length) {
        console.error(errors.join('\n'));
        process.exitCode = 1;
      } else {
        console.log('loop-agent contract valid');
      }
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  }
}
