// Archon-port follow-up (2026-05-08) — WorkflowDeps `runSkill` / `runCft`
// bridge. Closes Caveat #1 of 내부 문서
// (§5.2 + §7.1).
//
// Until this landed, workflow YAML containing `skill:` or `cft:` nodes
// failed with `'... not wired in this runtime'`. Both bridges share a
// single source of truth (this file) so the CLI (`elanous wf run`) and
// the Nexus REST API (`POST /v1/workflows/:name/run`) agree on
// behavior.
//
// Design notes:
//   - `runSkill(slug, args)` → `Promise<string>`. Looks up the manifest
//     via `parseSkillMd`, then calls `executeSkill` with a non-streaming
//     onChunk that buffers the full text. The skill runner already
//     applies its own SkillManifest tool policy (T1.1) — workflow
//     node-level allowed_tools/denied_tools are consumed at the executor
//     level via `NodeExecContext.toolPolicy` and not duplicated here.
//   - `runCft(method, config)` → `Promise<unknown>`. A small dispatch
//     table over the existing CFT methods (`src/cft/{dmaic,pdca,fmea,
//     a3,quick-kill,rca}.ts`). Each method has a different input/output
//     shape — we trust the YAML author to match the expected `config`
//     fields. Unknown methods throw a clear "supported methods: ..."
//     error so the workflow author sees an actionable message.

import { LOCAL_SKILLS_DIR } from '../config.js';
import { executeSkill, parseSkillMd } from '../skills/runner.js';
import { runDmaicPhase, type DmaicPhase } from '../cft/dmaic.js';
import { runPdcaPhase, type PdcaPhase, type PdcaDecision } from '../cft/pdca.js';
import { buildReport as buildFmeaReport, type FMEARow } from '../cft/fmea.js';
import { renderA3, type A3Input } from '../cft/a3.js';
import { triageQuickKill, type QuickKillInput } from '../cft/quick-kill.js';
import {
  buildFishbone,
  buildWhyChain,
  computePareto,
  FISHBONE_CATEGORIES,
} from '../cft/rca.js';

/** Build a `runSkill(slug, args)` bridge backed by `executeSkill`. The
 *  optional `signal` is forwarded to the skill runner so workflow-level
 *  abort propagates. Returns the skill's full response text. */
export function buildRunSkill(opts: { signal?: AbortSignal } = {}) {
  return async function runSkill(slug: string, args: string, runOpts: { skillsDir?: string } = {}): Promise<string> {
    // 플러그인 노드는 자기 팩의 `skills/` 를 먼저 본다 — 설치자 HOME 에 기대지 않는다(🅕 K3 실물 09-30).
    const manifest = (runOpts.skillsDir ? parseSkillMd(slug, runOpts.skillsDir) : null) ?? parseSkillMd(slug, LOCAL_SKILLS_DIR);
    if (!manifest) {
      throw new Error(
        `unknown skill '${slug}'. Skills are loaded from ${runOpts.skillsDir ? `${runOpts.skillsDir}, then ` : ''}${LOCAL_SKILLS_DIR} (or ~/.claude/skills) — check the slug or add a SKILL.md.`,
      );
    }
    let buffered = '';
    const result = await executeSkill(
      manifest,
      args,
      (_delta: string, full: string) => { buffered = full; },
      {
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      },
    );
    // `fullResponse` is authoritative; the buffered tail is a fallback
    // for providers that emit only partial chunks.
    return result.fullResponse || buffered;
  };
}

/** Supported CFT methods — kept in sync with the dispatch in `runCft`.
 *  Exposed so callers (and tests) can list / validate before dispatch. */
export const SUPPORTED_CFT_METHODS = [
  'dmaic',
  'pdca',
  'fmea',
  'a3',
  'quick-kill',
  'quickkill',
  'rca-5why',
  'rca-fishbone',
  'rca-pareto',
] as const;

export type CftMethodName = (typeof SUPPORTED_CFT_METHODS)[number];

/** Build a `runCft(method, config)` bridge that dispatches to the
 *  appropriate `src/cft/*` function. Each method has its own
 *  input/output shape — we cast `config` to that shape and trust the
 *  YAML author. Unknown methods throw a "supported methods: …" error. */
export function buildRunCft() {
  return async function runCft(
    method: string,
    config: Record<string, unknown>,
  ): Promise<unknown> {
    const m = method.toLowerCase().trim();
    switch (m) {
      case 'dmaic': {
        return runDmaicPhase({
          problem: requireString(config, 'problem'),
          phase: requireString(config, 'phase') as DmaicPhase,
          activities: optionalStringArray(config, 'activities'),
        });
      }
      case 'pdca': {
        const decision = config['decision'];
        const input: Parameters<typeof runPdcaPhase>[0] = {
          subject:
            typeof config['subject'] === 'string'
              ? (config['subject'] as string)
              : requireString(config, 'goal'),
          phase: (typeof config['phase'] === 'string'
            ? (config['phase'] as PdcaPhase)
            : 'plan') as PdcaPhase,
          activities: optionalStringArray(config, 'activities'),
          ...(typeof decision === 'string'
            ? { decision: decision as PdcaDecision }
            : {}),
        };
        return runPdcaPhase(input);
      }
      case 'fmea': {
        const rowsRaw = config['rows'];
        if (!Array.isArray(rowsRaw)) {
          throw new Error(`cft method 'fmea' requires config.rows: FMEARow[]`);
        }
        return buildFmeaReport(
          requireString(config, 'system'),
          rowsRaw as readonly FMEARow[],
        );
      }
      case 'a3': {
        return renderA3(config as unknown as A3Input);
      }
      case 'quick-kill':
      case 'quickkill': {
        return triageQuickKill(config as unknown as QuickKillInput);
      }
      case 'rca-5why': {
        return buildWhyChain(
          requireString(config, 'problem'),
          optionalStringArray(config, 'whys') ?? [],
        );
      }
      case 'rca-fishbone': {
        const causes = config['causes'];
        if (!causes || typeof causes !== 'object') {
          throw new Error(
            `cft method 'rca-fishbone' requires config.causes: Record<category, string[]>`,
          );
        }
        return buildFishbone(
          requireString(config, 'problem'),
          causes as Partial<Record<(typeof FISHBONE_CATEGORIES)[number], readonly string[]>>,
        );
      }
      case 'rca-pareto': {
        const items = config['items'];
        if (!Array.isArray(items)) {
          throw new Error(`cft method 'rca-pareto' requires config.items: Array<{label,count}>`);
        }
        const threshold = typeof config['threshold'] === 'number'
          ? (config['threshold'] as number)
          : undefined;
        return computePareto(
          requireString(config, 'title'),
          items as readonly { label: string; count: number }[],
          ...(threshold !== undefined ? [threshold] as const : [] as const),
        );
      }
      default:
        throw new Error(
          `unknown cft method '${method}'. Supported: ${SUPPORTED_CFT_METHODS.join(', ')}.`,
        );
    }
  };
}

function requireString(cfg: Record<string, unknown>, key: string): string {
  const v = cfg[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`cft config requires '${key}' (string)`);
  }
  return v;
}

function optionalStringArray(
  cfg: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const v = cfg[key];
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') {
    return v.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
  }
  return undefined;
}
