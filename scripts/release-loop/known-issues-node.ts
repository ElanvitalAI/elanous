#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';
import type { GraphRunState } from '../../src/graph-runner/runner.js';
import { join } from 'node:path';
import { emitNodeResult, readGraphContext, runCommand, type CommandRunner, type GraphContext } from './node-verdict.js';

const FALLBACK = 'Known issues have been reported for this release.';
const APPROVED_0233_INPUT = JSON.parse(readFileSync(join(import.meta.dir, 'known-issues-0.2.33-approved.json'), 'utf8')) as Issue[];
const APPROVED_0233_BY_ID = new Map(APPROVED_0233_INPUT.map((issue) => [issue.id, issue.note]));
const APPROVED_0233_BULLETS = new Map([
  ['KI-0233-REGRESSIONS · 0.2.33: 사용자 영향은 bot routine dry-run 루틴 사용 금지. 격리 시험은 검증되지 않았으며 0.2.34에서 복원·재검증한다.', 'Bot routine dry runs must not be used in this release.'],
  ['KI-0233-REGRESSIONS · 0.2.33: 이 경로의 검증 공백이다. 기능이 검증됐다고 간주하지 말고 0.2.34에서 수리·시험 복원 뒤 재검증한다.', 'Some paths remain unverified in this release.'],
  ['KI-0233-REGRESSIONS · 0.2.33: 옛 판 오프너 경보가 지연되거나 누락될 수 있다. 0.2.34에서 독립 fixture와 Linux Pod 실물 검증 후 복원한다.', 'Old version opener alerts may be delayed or missed in this release.'],
]);
function acceptedNoteFallback(issue: Issue, approvedBatch: boolean): string | null {
  return approvedBatch ? APPROVED_0233_BULLETS.get(issue.note ?? '') ?? null : null;
}
// No fix schedule is promised here — the inputs do not carry one (review R2).
const INTRO = 'The following issues are known in this release.';
// A known-issues bullet describes a problem that is still there; «fixed / resolved» wording turns it into a false claim.
const resolved = /\b(?:fixed|resolved|no longer|has been addressed|is addressed|was addressed)\b/i;
const unsafe = /[^\x20-\x7e]|#\d+|\/Users\/|\.test\.ts\b|\[(?:TC|MK|OP|UX|S|T|F|O)\]|\b(?:TC|MK|OP|UX)\s+track\b|\b(?:PR|pull request)\s*\d+\b|\b(?:scripts|src|test)\/\S+|\bfile:\/\/|(?<![\w:/])\/(?!\/)[\w.-]+(?:\/[\w.-]+)*|\b[A-Z]:\\(?:[^\s\\]+\\)*[^\s\\]+|\b(?:RFC|HANDOFF|MANUAL)-/i;

type Issue = { id: string; title?: string; evidence?: string; note?: string };

// Accepted regressions with the same public note describe one issue, even if several gates recorded it.
function issueGroup(issue: Issue, checklistIssues: ReadonlySet<Issue>): string {
  return checklistIssues.has(issue) ? `checklist:${issue.id}` : `accepted:${issue.note}`;
}

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
  // Korean accepted notes may share their only English token (a tracking label) across
  // distinct note groups. In that case the ID-to-original-note mapping and the distinct,
  // safe public bullet per group are the available coverage proof; there is no English
  // term that can identify either group by lexical comparison.
  if (issue.note !== undefined && others.length > 0 && distinctive.length === 0 && /[^\x00-\x7f]/.test(source)) return true;
  return distinctive.length > 0 && distinctive.some((word) => publicWords.has(word));
}

function cleanBullet(text: string): string | null {
  const line = text.trim();
  if (!line || /^[-*]\s/.test(line) || unsafe.test(line) || /[{}<>\[\]`]/.test(line) || (line.match(/[.!?](?:\s|$)/g) ?? []).length > 2) return null;
  return line;
}

/** A waiver is copied verbatim into public notes, so reject internal or resolved claims before resuming. */
export function publicWaiverReason(text: string): string {
  const bullet = cleanBullet(text);
  if (!bullet || resolved.test(bullet) || !/[a-z]{3}/i.test(bullet)) throw new Error('unsafe public waiver reason');
  return bullet;
}

function recordedWaivers(context: GraphContext, accepted: Issue[]): Issue[] {
  const contextPath = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!contextPath || !/\.json\.contexts\/[1-9]\d*\.json$/.test(contextPath)) return [];
  const raw = JSON.parse(readFileSync(contextPath, 'utf8')) as { graphId?: string; runId?: string; nodeId?: string };
  if (raw.graphId !== 'release-loop' || raw.nodeId !== 'known-issues' || !raw.runId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw.runId)) return [];
  const statePath = join(effectiveInstanceRoot(), 'graph-runs', 'release-loop', `${raw.runId}.json`);
  const visit = Number(contextPath.slice(contextPath.lastIndexOf('/') + 1, -'.json'.length));
  if (contextPath !== join(`${statePath}.contexts`, `${visit}.json`)) return [];
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as GraphRunState;
  if (state.graphId !== 'release-loop' || state.runId !== raw.runId || state.path[visit - 1] !== 'known-issues' ||
    JSON.stringify((state.input as { acceptedRegressions?: unknown })?.acceptedRegressions ?? []) !== JSON.stringify(context.input.acceptedRegressions ?? [])) return [];
  return accepted.filter((issue) => {
    if (!issue.id.startsWith('waive:')) return false;
    const node = issue.id.slice('waive:'.length);
    const index = state.path.indexOf(node);
    const record = state.nodes[index];
    const waiver = record?.waiver;
    return index >= 0 && index < visit - 1 && record?.nodeId === node && waiver !== undefined && waiver.reason === issue.note &&
      // The runner writes a waiver only over a failed executed node (releaseResumeWaiver); its exit may be 0 (outcome fail) or null (timeout).
      record.ok === true && record.executed === false &&
      context.outputs[node]?.verdict === 'waived' && context.outputs[node]?.reason === issue.note;
  });
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
  const approved0233Batch = version === '0.2.33' && accepted.length === APPROVED_0233_INPUT.length
    && new Set(accepted.map((issue) => issue.id)).size === accepted.length
    && accepted.every((issue) => APPROVED_0233_BY_ID.get(issue.id) === issue.note);
  const sources = { checklist: checklist.length, accepted: accepted.length };
  if (!checklist.length && !accepted.length) return { outcome: 'ok' as const, verdict: 'pass' as const, summary: '알려진 문제 없음', count: 0, bullets: [] as string[], sources, fallbackUsed: false };

  let bullets: string[];
  let fallbackUsed = false;
  const groupByBullet = new Map<string, string>();
  const sourceGroupByRawBullet = new Map<string, string>();
  const checklistIssues = new Set<Issue>(checklist);
  // The persisted failed-node waiver, not a claimed output or an ID prefix, is the public-note provenance.
  const waiverIssues = recordedWaivers(context, accepted);
  const waiverNotes = new Set(waiverIssues.map((issue) => issue.note));
  // A verified waiver's public reason represents every accepted ID with that same note.
  const acceptedForModel = accepted.filter((issue) => !waiverNotes.has(issue.note));
  const modelIssues = [...checklist, ...acceptedForModel];
  const sourceIds = modelIssues.map((issue) => issue.id);
  const prompt = `Write public English release-note bullets for these known issues. Describe only user-visible impact; include a one-line workaround when available. No internal names, test paths, track names, PR numbers, or people. Each bullet must have at most two sentences. Return ONLY a JSON array with exactly one object {"id":"input ID","bullet":"English public sentence"} for each input, using each input ID exactly once. Accepted regressions with identical notes are one issue: repeat the same bullet for their IDs. Do not include IDs in bullet text. Input: ${JSON.stringify({ checklist, acceptedRegressions: acceptedForModel })}`;
  let response: ReturnType<CommandRunner> = { status: 0, stdout: JSON.stringify({ reply: '[]' }), stderr: '' };
  if (modelIssues.length) {
    try {
      response = run('elanous', ['--test', 'ask', '--json', prompt]);
    } catch {
      response = { status: 1, stdout: '', stderr: '' };
    }
  }
  if (response.status !== 0) {
    bullets = [FALLBACK];
    fallbackUsed = true;
  } else {
    try {
      const fallbackGroups = new Set<string>();
      bullets = generatedBullets(response.stdout, sourceIds).map((line, index) => {
        const issue = modelIssues[index]!;
        const group = issueGroup(issue, checklistIssues);
        const raw = line.trim();
        const previousGroup = sourceGroupByRawBullet.get(raw);
        if (previousGroup && previousGroup !== group) throw new Error('known issues response repeats or splits an issue instead of covering each input');
        sourceGroupByRawBullet.set(raw, group);
        const safe = cleanBullet(line);
        if (!safe) {
          fallbackUsed = true;
          return FALLBACK;
        }
        if (resolved.test(safe)) {
          if (checklistIssues.has(issue) || !/[^\x00-\x7f]/.test(issue.note ?? '')) throw new Error(`bullet for ${sourceIds[index]} claims the issue is resolved`);
          const replacement = acceptedNoteFallback(issue, approved0233Batch);
          if (!replacement) throw new Error(`deterministic public bullet unavailable for ${sourceIds[index]}`);
          fallbackUsed = true;
          fallbackGroups.add(group);
          return replacement;
        }
        if (!coversIssue(safe, issue, modelIssues.filter((other, otherIndex) => otherIndex !== index && issueGroup(other, checklistIssues) !== group))) {
          if (!checklistIssues.has(issue) && /[^\x00-\x7f]/.test(issue.note ?? '')) {
            const replacement = acceptedNoteFallback(issue, approved0233Batch);
            if (!replacement) throw new Error(`deterministic public bullet unavailable for ${sourceIds[index]}`);
            fallbackUsed = true;
            fallbackGroups.add(group);
            return replacement;
          }
          throw new Error(`bullet does not identify input ${sourceIds[index]}`);
        }
        return safe;
      });
      // One accepted note is one public issue. A failed ID cannot leave a mixed model/fallback group.
      bullets = bullets.map((bullet, index) => fallbackGroups.has(issueGroup(modelIssues[index]!, checklistIssues))
        ? acceptedNoteFallback(modelIssues[index]!, approved0233Batch)! : bullet);
      const bulletByGroup = new Map<string, string>();
      for (const [index, bullet] of bullets.entries()) {
        const group = issueGroup(modelIssues[index]!, checklistIssues);
        if (bulletByGroup.has(group) && bulletByGroup.get(group) !== bullet) {
          throw new Error('known issues response repeats or splits an issue instead of covering each input');
        }
        bulletByGroup.set(group, bullet);
        if (bullet === FALLBACK) continue;
        if (groupByBullet.has(bullet) && groupByBullet.get(bullet) !== group) {
          throw new Error('known issues response repeats or splits an issue instead of covering each input');
        }
        groupByBullet.set(bullet, group);
      }
      bullets = [...new Set(bullets)];
    } catch (error) {
      throw new Error(`known issues coverage not verified: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // A waiver's supplied public impact must survive even when the model omits it or is unavailable.
  // The generic fallback may aggregate model issues, but it cannot also stand in for a distinct waiver group.
  if (bullets.includes(FALLBACK)) groupByBullet.set(FALLBACK, 'fallback-aggregate');
  for (const issue of waiverIssues) {
    const bullet = cleanBullet(issue.note ?? '');
    if (!bullet || resolved.test(bullet)) throw new Error(`unsafe public waiver reason for ${issue.id}`);
    const publicBullet = /[.!?]$/.test(bullet) ? bullet : `${bullet}.`;
    const group = issueGroup(issue, checklistIssues);
    if (groupByBullet.has(publicBullet) && groupByBullet.get(publicBullet) !== group) {
      throw new Error(`known issues coverage not verified: waiver bullet repeats another issue for ${issue.id}`);
    }
    groupByBullet.set(publicBullet, group);
    if (!bullets.includes(publicBullet)) bullets.push(publicBullet);
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
