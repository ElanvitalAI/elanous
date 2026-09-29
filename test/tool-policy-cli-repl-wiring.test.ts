// Archon-port T1.2 (2026-05-08) — verify user-config `chat.toolDeny`
// is now applied to both the main CLI agent path (`src/index.ts`) and
// the REPL path (`src/repl/index.ts`).
//
// Pre-T1.2, only `eval-prompt-cli.ts` honored `chat.toolDeny` —
// `elanous ask` (CLI agent) and `elanous repl` (REPL) silently ignored
// it. This test guards that wiring lift directly: we read the source
// and assert the policy is applied at the runTurn call site.
//
// Pure-string assertion is the right level: the actual filter contract
// (`applyToolPolicy`) has its own dedicated test file
// (`test/tool-policy.test.ts`) — duplicating the behavior tests here
// would be brittle. What we want to catch is "someone removed the
// hook", which a presence assertion covers.
//
// 🪞⭐⭐ 2026-08-26 — 이 파일이 ***스스로 적은 의도와 다른 것을 물고 있었다.***
//   ❌ 옛 단언  src.indexOf('await runTurn({\n    userConfig: opts.cfg')
//      ⇒ ***공백과 줄바꿈까지 문다.*** src/index.ts 가 호출을 «주입 가능»하게 바꾸자
//        (`await (opts.runTurn ?? runTurn)({`) 그 리터럴이 -1 이 됐고 시험이 빨개졌다.
//      🚨 즉 ***소스가 «좋아져서» 빨개졌다*** — 계약은 «내내» 지켜지고 있었다.
//   🚨 그리고 더 나쁜 것: 옛 단언은 ***진짜 계약을 «안» 물었다.***
//      「걸렀다」와 「거른 것이 «실제로 넘어간다»」는 다른 값인데,
//      필터 결과를 «아무도 안 넘기는» 코드도 옛 시험을 통과했다.
//   ⇒ 🩹 그래서 ⓐ 순서는 «포맷에 안 기대는» 자로 바꾸고
//        ⓑ ***「거른 변수가 tools: 로 넘어가나」***를 «새로» 문다.

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = join(import.meta.dir, '..');
// The CLI agent turn moved out of src/index.ts in the D4c split.
const cliPath = join(repoRoot, 'src', 'cli', 'agent-cli.ts');
const replPath = join(repoRoot, 'src', 'repl', 'index.ts');

describe('Archon-port T1.2 — CLI + REPL apply chat.toolDeny', () => {
  it('main CLI (src/cli/agent-cli.ts) calls applyToolPolicy on cfg.chat.toolDeny', () => {
    const src = readFileSync(cliPath, 'utf-8');
    expect(src).toContain('applyToolPolicy');
    expect(src).toContain('opts.cfg.chat.toolDeny');
    // Hook fires BEFORE runTurn — both must appear and the hook
    // must precede the call site.
    // ⛔ 포맷에 «안 기댄다» — 직접 호출이든 주입 이음매든(`(opts.runTurn ?? runTurn)`) 문다.
    const hookIdx = src.indexOf('applyToolPolicy');
    const runTurnIdx = src.search(/await\s*\(?\s*(?:opts\.runTurn\s*\?\?\s*)?runTurn\)?\(\{/);
    expect(hookIdx).toBeGreaterThan(0);
    expect(runTurnIdx).toBeGreaterThan(hookIdx);
    // ⛔⭐⭐ 진짜 계약 — ***거른 값이 «실제로 넘어가나».***
    //   이것이 없으면 「걸러 놓고 안 넘기는」 코드가 위 단언들을 «공짜로» 통과한다.
    expect(src).toMatch(/cliToolSpecs\s*=\s*applyToolPolicy\(/);
    expect(src.indexOf('tools: cliToolSpecs')).toBeGreaterThan(hookIdx);
  });

  it('REPL (src/repl/index.ts) calls applyToolPolicy on cfg.chat.toolDeny', () => {
    const src = readFileSync(replPath, 'utf-8');
    expect(src).toContain('applyToolPolicy');
    expect(src).toContain('cfg.chat.toolDeny');
    const hookIdx = src.indexOf('applyToolPolicy');
    const runTurnIdx = src.search(/await\s*\(?\s*(?:opts\.runTurn\s*\?\?\s*)?runTurn\)?\(\{/);
    expect(hookIdx).toBeGreaterThan(0);
    expect(runTurnIdx).toBeGreaterThan(hookIdx);
    // ⛔ CLI 쪽과 «같은 계약» — 거른 값이 실제로 넘어가나.
    //   📌 REPL 은 옛 리터럴이 «아직» 맞아서 초록이었다. 그러나 약점은 «같았다» ⇒ 같이 잠근다.
    expect(src).toMatch(/replToolSpecs\s*=\s*applyToolPolicy\(/);
    expect(src.indexOf('tools: replToolSpecs')).toBeGreaterThan(hookIdx);
  });
});
