import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { convertBriefToRequirements, type BriefInput, type AbsorbBriefInput } from './convert.js';

try {
  const contextPath = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!contextPath || !isAbsolute(contextPath)) throw new Error('ELANOUS_GRAPH_CONTEXT must be absolute');
  const context = JSON.parse(readFileSync(contextPath, 'utf8')) as { input?: { briefPath?: string; outDir?: string } };
  const briefPath = context.input?.briefPath;
  if (!briefPath || !isAbsolute(briefPath) || !existsSync(briefPath)) throw new Error('briefPath must be an existing absolute path');
  const outDir = context.input?.outDir ?? join(dirname(contextPath), 'brief-to-requirements');
  if (!isAbsolute(outDir)) throw new Error('outDir must be absolute');
  const receipt = convertBriefToRequirements(JSON.parse(readFileSync(briefPath, 'utf8')) as BriefInput | AbsorbBriefInput);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'requirements.txt'), receipt.prompt + '\n');
  writeFileSync(join(outDir, 'requirements.json'), JSON.stringify({ ...receipt, inputPath: briefPath }, null, 2) + '\n');
  console.log(JSON.stringify({ outcome: 'ok', outDir, lines: receipt.lines, sourceScrapIds: receipt.sourceScrapIds }));
} catch (error) {
  console.log(JSON.stringify({ outcome: 'fail', error: error instanceof Error ? error.message : String(error) }));
}
