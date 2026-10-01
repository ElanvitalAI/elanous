#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitNodeResult, readGraphContext, runCommand, type CommandRunner, type GraphContext } from './node-verdict.js';

const FALLBACK = 'Known issues have been reported for this release.';
// No fix schedule is promised here — the inputs do not carry one (review R2).
const INTRO = 'The following issues are known in this release.';
// A known-issues bullet describes a problem that is still there; «fixed / resolved» wording turns it into a false claim.
const resolved = /\b(?:fixed|resolved|no longer|has been addressed|is addressed|was addressed)\b/i;
const unsafe = /[^\x20-\x7e]|#\d+|\/Users\/|\.test\.ts\b|\[(?:TC|MK|OP|UX|S|T|F|O)\]|\b(?:TC|MK|OP|UX)\s+track\b|\b(?:PR|pull request)\s*\d+\b|\b(?:scripts|src|test)\/\S+|\bfile:\/\/|(?<![\w:/])\/(?!\/)[\w.-]+(?:\/[\w.-]+)*|\b[A-Z]:\\(?:[^\s\\]+\\)*[^\s\\]+|\b(?:RFC|HANDOFF|MANUAL)-/i;

type Issue = { id: string; title?: string; evidence?: string; note?: string };

function issues(value: unknown, kind: 'checklist' | 'accepted'): Issue[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => item && typeof item === 'object'
    && typeof item.id === 'string' && item.id.trim()
    && (kind === 'checklist' ? typeof item.title === 'string' && typeof item.evidence === 'string' : typeof item.note === 'string'))) {
    throw new Error(`invalid ${kind} known issues`);
  }
  return value as Issue[];
}

function generatedBullets(raw: string, sourceIds: string[]): string[] {
  const envelope: unknown = JSON.parse(raw.trim());
  const reply = envelope && typeof envelope === 'object' && !Array.isArray(envelope) && 'reply' in envelope
    ? envelope.reply : envelope;
  if (typeof reply !== 'string') throw new Error('empty ask reply');
  const entries: unknown = JSON.parse(reply.replace(/^```(?:json)?\s*\n|\n```\s*$/g, '').trim());
  if (!Array.isArray(entries) || entries.length !== sourceIds.length || new Set(sourceIds).size !== sourceIds.length) {
    throw new Error('known issues response does not cover every input ID');
  }
  const byId = new Map<string, string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.id !== 'string' || typeof entry.bullet !== 'string'
      || byId.has(entry.id) || !sourceIds.includes(entry.id)) {
      throw new Error('known issues response does not cover every input ID');
    }
    byId.set(entry.id, entry.bullet);
  }
  if (sourceIds.some((id) => !byId.has(id))) throw new Error('known issues response does not cover every input ID');
  return sourceIds.map((id) => byId.get(id)!);
}

function coversIssue(bullet: string, issue: Issue, others: Issue[]): boolean {
  const source = issue.title ?? issue.note ?? '';
  const words = source.toLowerCase().match(/[a-z]{5,}/g) ?? [];
  const otherWords = new Set(others.flatMap((other) => ((other.title ?? other.note ?? '').toLowerCase().match(/[a-z]{5,}/g) ?? []).map((word) => word.slice(0, 5))));
  const publicWords = new Set((bullet.toLowerCase().match(/[a-z]{5,}/g) ?? []).map((word) => word.slice(0, 5)));
  const distinctive = [...new Set(words.map((word) => word.slice(0, 5)))].filter((word) => !otherWords.has(word));
  const negative = /\b(?:not|never|no|cannot|can't|doesn't|don't|won't|fails? to|isn't|aren't)\b/i;
  if (negative.test(source) && !negative.test(bullet)) return false;
  // A source with no English words to compare (e.g. a Korean checklist title) is covered structurally —
  // one bullet per input ID — instead of blocking the release (review R2).
  if (words.length === 0) return true;
  return distinctive.length > 0 && distinctive.filter((word) => publicWords.has(word)).length >= Math.min(issue.note === undefined ? 1 : 2, distinctive.length);
}

function cleanBullet(text: string): string | null {
  const line = text.trim();
  if (!line || /^[-*]\s/.test(line) || unsafe.test(line) || /[{}<>\[\]`]/.test(line) || (line.match(/[.!?](?:\s|$)/g) ?? []).length > 2) return null;
  return line;
}

function command(run: CommandRunner, program: string, args: string[], cwd?: string): string {
  const result = run(program, args, cwd);
  if (result.status !== 0) throw new Error(`${program} ${args[0]} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

export function runKnownIssues(context: GraphContext = readGraphContext(), run: CommandRunner = runCommand) {
  const version = context.input.version;
  const worktree = context.outputs.docs?.worktree;
  if (typeof worktree !== 'string' || !worktree || !existsSync(worktree)) throw new Error('docs 워크트리 없음');
  if (context.outputs.docs?.branch !== `release-docs/${version}`) throw new Error('docs branch/version mismatch');
  const notes = join(worktree, 'release/public/docs/releases', `${version}.md`);
  if (!existsSync(notes)) throw new Error(`release notes missing: ${notes}`);
  const checklist = issues(context.outputs['checklist-gate']?.knownIssues, 'checklist');
  const accepted = issues(context.input.acceptedRegressions, 'accepted');
  const sources = { checklist: checklist.length, accepted: accepted.length };
  if (!checklist.length && !accepted.length) return { outcome: 'ok' as const, verdict: 'pass' as const, summary: '알려진 문제 없음', count: 0, bullets: [] as string[], sources, fallbackUsed: false };

  let bullets: string[];
  let fallbackUsed = false;
  const allIssues = [...checklist, ...accepted];
  const sourceIds = allIssues.map((issue) => issue.id);
  const prompt = `Write public English release-note bullets for these known issues. Describe only user-visible impact; include a one-line workaround when available. No internal names, test paths, track names, PR numbers, or people. Each bullet must have at most two sentences. Return ONLY a JSON array with exactly one object {"id":"input ID","bullet":"English public sentence"} for each input, using each input ID exactly once. Do not include IDs in bullet text. Input: ${JSON.stringify({ checklist, acceptedRegressions: accepted })}`;
  let response: ReturnType<CommandRunner>;
  try {
    response = run('elanous', ['--test', 'ask', '--json', prompt]);
  } catch {
    response = { status: 1, stdout: '', stderr: '' };
  }
  if (response.status !== 0) {
    bullets = [FALLBACK];
    fallbackUsed = true;
  } else {
    try {
      bullets = generatedBullets(response.stdout, sourceIds).map((line, index) => {
        const safe = cleanBullet(line);
        if (!safe) {
          fallbackUsed = true;
          return FALLBACK;
        }
        if (resolved.test(safe)) throw new Error(`bullet for ${sourceIds[index]} claims the issue is resolved`);
        if (!coversIssue(safe, allIssues[index]!, allIssues.filter((_, otherIndex) => otherIndex !== index))) {
          throw new Error(`bullet does not identify input ${sourceIds[index]}`);
        }
        return safe;
      });
      if (new Set(bullets).size !== bullets.length && bullets.some((bullet) => bullet !== FALLBACK)) {
        throw new Error('known issues response repeats an issue instead of covering each input');
      }
      bullets = [...new Set(bullets)];
    } catch (error) {
      throw new Error(`known issues coverage not verified: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const original = readFileSync(notes, 'utf8');
  const heading = /^## Known issues\s*$/m;
  const match = heading.exec(original);
  let updated: string;
  if (match) {
    const start = match.index + match[0].length;
    const next = /^## /gm;
    next.lastIndex = start;
    const end = next.exec(original)?.index ?? original.length;
    const section = original.slice(start, end);
    const additions = bullets.filter((bullet) => !section.split(/\r?\n/).some((line) => line.trim() === `- ${bullet}`));
    const before = original.slice(0, end);
    updated = additions.length ? `${before}${before.endsWith('\n') ? '' : '\n'}${additions.map((bullet) => `- ${bullet}`).join('\n')}\n\n${original.slice(end)}` : original;
  } else {
    updated = `${original.trimEnd()}\n\n## Known issues\n\n${INTRO}\n\n${bullets.map((bullet) => `- ${bullet}`).join('\n')}\n`;
  }
  if (updated !== original) {
    writeFileSync(notes, updated);
    command(run, 'git', ['add', '--', `release/public/docs/releases/${version}.md`], worktree);
    command(run, 'git', ['commit', '-m', `docs: known issues for ${version}`], worktree);
  }
  // Push whenever the branch is ahead of its remote — a rerun after a failed push finds the bullets already in the file (review R2).
  command(run, 'git', ['fetch', 'origin', `release-docs/${version}`], worktree);
  const ahead = Number(command(run, 'git', ['rev-list', '--count', `origin/release-docs/${version}..HEAD`], worktree).trim());
  if (!Number.isFinite(ahead)) throw new Error('could not compare release-docs branch with its remote');
  if (ahead > 0) command(run, 'git', ['push', 'origin', `release-docs/${version}`], worktree);
  return { outcome: 'ok' as const, verdict: 'pass' as const, summary: `known issues: ${bullets.length}`, count: bullets.length, bullets, sources, fallbackUsed };
}

if (import.meta.main) {
  try {
    const result = runKnownIssues();
    emitNodeResult(result);
    process.exitCode = 0;
  } catch (error) {
    emitNodeResult({ outcome: 'fail', verdict: 'fail', summary: error instanceof Error ? error.message : String(error), count: 0, bullets: [], sources: { checklist: 0, accepted: 0 }, fallbackUsed: false });
    process.exitCode = 1;
  }
}
