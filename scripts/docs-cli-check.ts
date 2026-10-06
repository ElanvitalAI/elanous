#!/usr/bin/env bun
// 공개 문서에 적힌 `elanous …` 명령·하위 명령·플래그가 «실제 CLI» 에 있나 — 문서가 실제와 어긋나는 1순위 원인을 잡는다.
//   bun scripts/docs-cli-check.ts [--json] [files…]      (기본 = release/public/내부 문서 `*` ⊕ README.md)
// 🩸 계기(2026-09-25 🅢 RFC 피드백 ③): README·install.md 가 거짓이 된 원인이 전부 «설치기·doctor 가 바뀌었는데 문서가 모름»이었다.
// 자 = `bun bin/elanous.mjs <cmd> [<sub>] [<subsub>] --help` 산출(원천) — 문서의 코드 블록과 인라인 코드에서 `elanous ` 또는 `bun bin/elanous.mjs ` 로 시작하는 것만 본다.
// ⛔ 못 본 것은 «없다»로 적지 않는다: `--help` 가 실패하면 그 명령은 `unmeasured` 로 따로 센다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = resolve(import.meta.dir, '..');

export interface DocCommand { file: string; line: number; text: string; cmd: string; sub?: string; subsub?: string; flags: string[] }
export interface Finding { kind: 'unknown-command' | 'unknown-subcommand' | 'unknown-flag' | 'unmeasured'; ref: DocCommand; detail: string }

/** 코드 블록(``` … ```) 줄과 인라인 코드(`elanous …`)에서 elanous 호출을 뽑는다. 자리표(`<x>`)·셸 변수는 인자로 보고 넘긴다. */
export function extractElanousCommands(file: string, text: string): DocCommand[] {
  const out: DocCommand[] = [];
  let inFence = false;
  text.split('\n').forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; return; }
    const candidates: string[] = [];
    if (inFence) candidates.push(raw.replace(/#.*$/, ''));
    for (const m of raw.matchAll(/`((?:bun bin\/elanous\.mjs |elanous )[^`]+)`/g)) candidates.push(m[1]!);
    for (const c of candidates) {
      for (const seg of c.split(/&&|\|\||;|\|/)) {
        const m = /^(?:(?:\$\s+|>\s+|sudo\s+|[A-Za-z_][A-Za-z0-9_]*=\S+\s+))*(?:bun bin\/elanous\.mjs |elanous\s+)(.+)$/.exec(seg.trim());
        if (!m) continue;
        const tokens = m[1]!.trim().split(/\s+/).filter(Boolean);
        const cmd = tokens[0];
        if (!cmd || !/^[a-z][a-z0-9:-]*$/.test(cmd)) continue;
        const second = tokens[1];
        const sub = second && /^[a-z][a-z0-9-]*$/.test(second) ? second : undefined;
        const third = tokens[2];
        const subsub = sub && third && /^[a-z][a-z0-9-]*$/.test(third) ? third : undefined;
        const flags = tokens.filter((t) => /^--[a-z]/.test(t)).map((t) => t.replace(/[=,.)].*$/, ''));
        out.push({ file, line: i + 1, text: seg.trim(), cmd, ...(sub ? { sub } : {}), ...(subsub ? { subsub } : {}), flags });
      }
    }
  });
  return out;
}

export type HelpRunner = (args: string[]) => { ok: boolean; out: string };
const defaultHelp: HelpRunner = (args) => {
  const r = spawnSync('bun', ['bin/elanous.mjs', ...args, '--help'], { cwd: REPO, encoding: 'utf8', timeout: 60_000, env: { ...process.env, NO_COLOR: '1' } });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
};

function listed(help: string, name: string): boolean {
  const cmds = help.split(/\nCommands:\n/)[1] ?? '';
  // 별칭도 명령이다 — 도움말은 `self-update|update [options]` 로 찍는다(09-26: 문서의 `elanous update` 를 «없는 명령»으로 잡았다).
  const n = name.replace(/[-]/g, '\\-');
  return new RegExp(`^\\s+(?:\\S+\\|)*${n}(?:\\|\\S+)*(?:\\s|\\[|<|$)`, 'm').test(cmds);
}

export function checkCommands(refs: readonly DocCommand[], help: HelpRunner = defaultHelp): Finding[] {
  const cache = new Map<string, { ok: boolean; out: string }>();
  const get = (args: string[]) => { const k = args.join(' '); if (!cache.has(k)) cache.set(k, help(args)); return cache.get(k)!; };
  const root = get([]);
  const findings: Finding[] = [];
  for (const ref of refs) {
    if (!root.ok) { findings.push({ kind: 'unmeasured', ref, detail: 'elanous --help 실패' }); continue; }
    if (!listed(root.out, ref.cmd)) { findings.push({ kind: 'unknown-command', ref, detail: `elanous ${ref.cmd}` }); continue; }
    const cmdHelp = get([ref.cmd]);
    if (!cmdHelp.ok) { findings.push({ kind: 'unmeasured', ref, detail: `elanous ${ref.cmd} --help 실패` }); continue; }
    let flagsHelp = cmdHelp.out;
    let flagsPath = `elanous ${ref.cmd}`;
    if (ref.sub && /\nCommands:\n/.test(cmdHelp.out)) {
      if (!listed(cmdHelp.out, ref.sub)) { findings.push({ kind: 'unknown-subcommand', ref, detail: `elanous ${ref.cmd} ${ref.sub}` }); continue; }
      flagsPath = `elanous ${ref.cmd} ${ref.sub}`;
      const subHelp = get([ref.cmd, ref.sub]);
      if (!subHelp.ok) {
        findings.push({ kind: 'unmeasured', ref, detail: `${flagsPath} --help 실패` });
        continue;
      }
      flagsHelp = subHelp.out;
      if (ref.subsub && listed(subHelp.out, ref.subsub)) {
        flagsPath += ` ${ref.subsub}`;
        const subsubHelp = get([ref.cmd, ref.sub, ref.subsub]);
        if (!subsubHelp.ok) {
          findings.push({ kind: 'unmeasured', ref, detail: `${flagsPath} --help 실패` });
          continue;
        }
        flagsHelp = subsubHelp.out;
      }
    }
    for (const f of ref.flags) {
      if (!new RegExp(`(^|[\\s,])${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\b|[\\s,=<\\[])`, 'm').test(flagsHelp)) findings.push({ kind: 'unknown-flag', ref, detail: `${f} (${flagsPath})` });
    }
  }
  return findings;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) { const p = join(dir, e); if (statSync(p).isDirectory()) walk(p, out); else if (e.endsWith('.md')) out.push(p); }
  return out;
}

export function defaultFiles(): string[] {
  return [...walk(join(REPO, 'release', 'public', 'docs')), join(REPO, 'README.md')];
}

if (import.meta.main) {
  const args = process.argv.slice(2).filter((a) => a !== '--json');
  const files = args.length ? args.map((a) => resolve(a)) : defaultFiles();
  const refs = files.flatMap((f) => extractElanousCommands(relative(REPO, f), readFileSync(f, 'utf8')));
  const findings = checkCommands(refs);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ files: files.length, commands: refs.length, findings }));
  else {
    console.log(`docs-cli-check — 문서 ${files.length} · elanous 호출 ${refs.length} · 어긋남 ${findings.filter((f) => f.kind !== 'unmeasured').length} · 못 잰 것 ${findings.filter((f) => f.kind === 'unmeasured').length}`);
    for (const f of findings) console.log(`  ${f.kind}  ${f.ref.file}:${f.ref.line}  ${f.detail}   ← ${f.ref.text.slice(0, 90)}`);
  }
  process.exit(findings.length ? 1 : 0);
}
