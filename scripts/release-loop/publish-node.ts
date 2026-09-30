#!/usr/bin/env bun
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

export function runPublish(run: CommandRunner = runCommand) {
  const context = readGraphContext();
  const version = context.input.version;
  // A measured automatic decision or the existing human approval must authorize publication.
  const auto = context.outputs['auto-approve'];
  if (context.outputs['approve-publish']?.outcome !== 'approved' &&
    !(auto?.outcome === 'ok' && auto.decidedBy === 'release-loop metrics'
      && Array.isArray(auto.metrics) && auto.metrics.length === 8
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
    const published = run('bun', ['bin/elanous.mjs', 'release', 'publish', '--dir', out, '--notes-file', file, '--yes', '--json']);
    if (published.stderr) process.stderr.write(published.stderr);
    const result = lastResult(published);
    if (published.status === 1) return { outcome: 'fail' as const, verdict: 'fail' as const, summary: `release publish failed: ${result?.error ?? published.stderr.trim()}` };
    if (published.status !== 0 || result?.ok !== true || result.published !== true || result.tag !== `v${version}`) throw new Error(`release publish incomplete or tag mismatch: ${result?.error ?? published.stderr.trim()}`);
    return { outcome: 'ok' as const, verdict: 'pass' as const, summary: `published v${version}`, tag: `v${version}` };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (import.meta.main) {
  let version = '';
  try { version = readGraphContext().input.version; process.exitCode = finishNode('publish', version, runPublish()); }
  catch (error) { process.exitCode = finishNode('publish', version, errorResult(error)); }
}
