#!/usr/bin/env bun
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WARNING_ONLY } from './auto-approve-node.js';
import { beginLandingMerge, landingFreezeMessage } from '../../src/release-loop/landing-freeze.js';
import { debug } from '../../src/debug/log.js';
import { errorResult, finishNode, lastResult, nodeOutput, readGraphContext, runCommand, type CommandRunner } from './node-verdict.js';

export function publicNotes(markdown: string, pages: { pages: Array<{ id: string; slug?: string; source?: string }> }): string {
  if (!Array.isArray(pages.pages)) throw new Error('invalid public pages registry');
  const byFile = new Map(pages.pages.filter((p) => p.source).map((p) => [p.source!.split('/').at(-1), p]));
  if (!/^# [^\n]+\r?\n/.test(markdown)) throw new Error('release notes heading missing');
  const body = markdown.replace(/^# [^\n]+\r?\n(?:\r?\n)?/, '');
  return body.replace(/\[([^\]]+)\]\(([^)#?]+\.md)\)/g, (original, label: string, path: string) => {
    if (/^[a-z]+:\/\//i.test(path)) return original;
    const page = byFile.get(path.split('/').at(-1));
    if (!page) throw new Error(`no public page for link: ${path}`);
    return `[${label}](https://docs.elanous.ai${(page.slug ?? `/${page.id}`).replace(/\/$/, '')})`;
  });
}

/** Polls each release asset until it answers 200 (following redirects). Returns the names still missing. */
export function waitForAssets(run: CommandRunner, repo: string, tag: string, names: readonly string[], waitSeconds: unknown = 600,
  sleep: (ms: number) => void = (ms) => Bun.sleepSync(ms)): string[] {
  if (!repo || names.length === 0) return [];
  const limit = typeof waitSeconds === 'number' && Number.isFinite(waitSeconds) && waitSeconds >= 0 ? Math.min(waitSeconds, 1800) : 600;
  let pending = [...names];
  for (let waited = 0; ; waited += 15) {
    pending = pending.filter((name) => {
      const probe = run('curl', ['-sIL', '-o', '/dev/null', '-w', '%{http_code}', '-m', '20', `https://github.com/${repo}/releases/download/${tag}/${name}`]);
      return probe.stdout.trim() !== '200';
    });
    if (pending.length === 0 || waited >= limit) return pending;
    sleep(15_000);
  }
}

export function runPublish(run: CommandRunner = runCommand) {
  const context = readGraphContext();
  const version = context.input.version;
  // A measured automatic decision or the existing human approval must authorize publication.
  const auto = context.outputs['auto-approve'];
  if (context.outputs['approve-publish']?.outcome !== 'approved' &&
    !(auto?.outcome === 'ok' && auto.decidedBy === 'release-loop metrics'
      // The 8 blocking metrics; warning-only rows (tui-regress · mac-smoke) are shown but never counted (V1g · MAC1).
      && Array.isArray(auto.metrics)
      && auto.metrics.filter((metric: unknown) => !(metric && typeof metric === 'object' && 'name' in metric && WARNING_ONLY.has(String(metric.name)))).length === 8
      && auto.metrics.every((metric: unknown) => metric && typeof metric === 'object' && 'verdict' in metric && metric.verdict === 'pass'))) {
    return { outcome: 'fail' as const, verdict: 'fail' as const, summary: 'publish blocked: neither auto-approve nor approve-publish approved' };
  }
  for (const node of ['gate', 'pwa', 'upgrade', 'tui', 'prepare', 'docs']) {
    if (context.outputs[node]?.outcome !== 'ok') return { outcome: 'fail' as const, verdict: 'fail' as const, summary: `publish blocked: ${node} outcome is not ok` };
  }
  if (nodeOutput(context, 'prepare', 'commit') !== nodeOutput(context, 'version-release', 'commit')) throw new Error('prepare commit differs from release commit');
  const out = nodeOutput(context, 'prepare', 'out');
  const branch = nodeOutput(context, 'docs', 'branch');
  if (branch !== `release-docs/${version}`) throw new Error('docs branch/version mismatch');
  const notes = `release/public/docs/releases/${version}.md`;
  const doc = run('git', ['show', `${branch}:${notes}`]);
  const registry = run('git', ['show', `${branch}:website/pages.json`]);
  if (doc.status !== 0 || registry.status !== 0) throw new Error(`docs branch missing notes or pages: ${branch}`);
  if (!doc.stdout.startsWith(`# ${version}\n`)) throw new Error('release notes version mismatch');
  const body = publicNotes(doc.stdout, JSON.parse(registry.stdout));
  const dir = mkdtempSync(join(tmpdir(), 'release-publish-notes-'));
  try {
    const file = join(dir, 'notes.md');
    writeFileSync(file, body);
    // Same in-flight marker as merges: `freeze on` waits for a publication that already passed this check.
    // Unlike a merge, a frozen publication is not queued: it fails, and the release run is run again after `freeze off`.
    const landing = beginLandingMerge();
    const frozen = landing.frozen;
    if (frozen) {
      landing.end(); // already released by beginLandingMerge when frozen; kept explicit so no path leaves a marker
      debug.log('release.run', context.input.forceFreeze === true ? 'freeze-forced' : 'frozen', { version, reason: frozen.reason, until: frozen.until, node: 'publish' });
      if (context.input.forceFreeze !== true) return { outcome: 'fail' as const, verdict: 'fail' as const, summary: `publish blocked: ${landingFreezeMessage(frozen)}` };
    }
    let published: ReturnType<typeof run>;
    try { published = run('bun', ['bin/elanous.mjs', 'release', 'publish', '--dir', out, '--notes-file', file, '--yes', '--json']); }
    finally { landing.end(); }
    if (published.stderr) process.stderr.write(published.stderr);
    const result = lastResult(published);
    if (published.status === 1) return { outcome: 'fail' as const, verdict: 'fail' as const, summary: `release publish failed: ${result?.error ?? published.stderr.trim()}` };
    if (published.status !== 0 || result?.ok !== true || result.published !== true || result.tag !== `v${version}`) throw new Error(`release publish incomplete or tag mismatch: ${result?.error ?? published.stderr.trim()}`);
    // REL3 — «published» only once every asset downloads. 10-01: the run went on to verify before GitHub served the
    // assets (release created 13:16Z, assets 13:20Z, run ended 13:15Z) and verify failed on a missing installer.
    const repo = typeof result.publicRepo === 'string' ? result.publicRepo : '';
    const names = Array.isArray(result.assets) ? (result.assets as unknown[]).filter((a): a is string => typeof a === 'string').map((a) => a.split('/').at(-1)!) : [];
    const pending = waitForAssets(run, repo, `v${version}`, names, context.input.assetWaitSeconds);
    if (pending.length) return { outcome: 'fail' as const, verdict: 'fail' as const, summary: `published v${version} but assets not downloadable yet: ${pending.join(', ')}`, tag: `v${version}` };
    return { outcome: 'ok' as const, verdict: 'pass' as const, summary: `published v${version} · ${names.length} assets downloadable`, tag: `v${version}` };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (import.meta.main) {
  let version = '';
  try { version = readGraphContext().input.version; process.exitCode = finishNode('publish', version, runPublish()); }
  catch (error) { process.exitCode = finishNode('publish', version, errorResult(error)); }
}
