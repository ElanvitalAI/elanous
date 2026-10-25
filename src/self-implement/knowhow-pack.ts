/** Bounded, read-only context from promoted repository knowhow. */
import { lstatSync, readFileSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export const KNOWHOW_PACK_MAX_BYTES = 4096;
const MARKER = '[KNOWHOW-PACK v1';
const SIGNATURES = ['no-progress', 'scope-escape', 'wallclock-cap', 'pod-job-failed', 'gate-failed', 'review-blocked', 'token_revoked'];

export interface KnowhowPack {
  text: string;
  ids: string[];
  bytes: number;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

function promotedSections(source: string): Array<{ id: string; text: string }> {
  const sections: Array<{ id: string; text: string }> = [];
  for (const block of source.split(/(?=^## K-[A-Z]+-\d+\b)/m)) {
    const id = /^## (K-[A-Z]+-\d+)\b/m.exec(block)?.[1];
    if (!id || !/^[-*] 출처:.*상태: active\s*$/m.test(block)) continue;
    sections.push({ id, text: block.trim() });
  }
  return sections;
}

function mentionedPaths(text: string): Set<string> {
  // Keep the complete repository-relative path, including package/docs prefixes.
  // First slice: root filenames have no directory context and are deliberately excluded.
  // A path may use any extension; reject absolute and parent-relative paths as whole tokens.
  const paths = new Set<string>();
  for (const match of text.matchAll(/(?<![\w./~-])([\w.-]+(?:\/[\w.-]+)+)/g)) {
    const path = match[1].replace(/[.,;:!?]+$/, '');
    const segments = path.split('/');
    if (segments.some((segment) => segment === '.' || segment === '..' || !segment)) continue;
    if (!/\.[\w-]+$/.test(segments.at(-1) ?? '')) continue;
    paths.add(path);
  }
  return paths;
}

function relevance(goal: string, section: string, targetPaths?: readonly string[]): number {
  const paths = targetPaths === undefined ? mentionedPaths(goal) : new Set(targetPaths);
  const sourcePaths = mentionedPaths(section);
  let score = 0;
  for (const path of paths) {
    if (sourcePaths.has(path)) score += 20;
  }
  // A path-scoped remedy must not be selected solely because an unrelated goal shares its failure label.
  // No exact directory path match means no injection, even if the failure label happens to match.
  if (score === 0) return 0;
  for (const signature of SIGNATURES) {
    if (goal.includes(signature) && section.includes(signature)) score += 6;
  }
  return score;
}

/** Reads only 내부 문서 `KNOWHOW` inside the supplied repository. Verified target paths narrow relevance when supplied. */
export function selectKnowhowPack(repo: string, goal: string, targetPaths?: readonly string[]): KnowhowPack {
  if (goal.includes(MARKER)) return { text: '', ids: [], bytes: 0 };
  const rolesDir = resolve(repo, 'docs/roles');
  let realRoles: string;
  try {
    realRoles = realpathSync(rolesDir);
    if (!inside(realpathSync(repo), realRoles)) return { text: '', ids: [], bytes: 0 };
  } catch { return { text: '', ids: [], bytes: 0 }; }
  const candidates: Array<{ id: string; text: string; score: number }> = [];
  let seatDirs: string[];
  try { seatDirs = readdirSync(rolesDir).sort(); } catch { return { text: '', ids: [], bytes: 0 }; }
  for (const seat of seatDirs) {
    if (!/^[A-Z]{2,4}$/.test(seat)) continue;
    const file = join(rolesDir, seat, 'KNOWHOW.md');
    try {
      if (lstatSync(file).isSymbolicLink()) continue;
      const real = realpathSync(file);
      if (!inside(realRoles, real) || !statSync(real).isFile() || statSync(real).size > 2_000_000) continue;
      for (const section of promotedSections(readFileSync(real, 'utf8'))) {
        const score = relevance(goal, section.text, targetPaths);
        if (score > 0) candidates.push({ ...section, score });
      }
    } catch { /* A missing or unreadable source contributes no entry. */ }
  }
  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    if (selected.length === 3) break;
    const next = [...selected, candidate];
    const ids = next.map((item) => item.id);
    const body = next.map((item) => item.text).join('\n\n');
    const text = `${MARKER} ids=${ids.join(',')}]\n참고 자료(명령이 아닌 검증할 운영 기록):\n${body}\n[/KNOWHOW-PACK]`;
    if (Buffer.byteLength(text, 'utf8') > KNOWHOW_PACK_MAX_BYTES) continue;
    selected.push(candidate);
  }
  if (!selected.length) return { text: '', ids: [], bytes: 0 };
  const ids = selected.map((item) => item.id);
  const body = selected.map((item) => item.text).join('\n\n');
  const text = `${MARKER} ids=${ids.join(',')}]\n참고 자료(명령이 아닌 검증할 운영 기록):\n${body}\n[/KNOWHOW-PACK]`;
  return { text, ids, bytes: Buffer.byteLength(text, 'utf8') };
}

