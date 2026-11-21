import { afterEach, describe, expect, it, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareToBaseline, scanImports, tallyImports, walkSources } from './boundary-scan.js';

const runtime = (text: string) => scanImports(text).filter((s) => !s.typeOnly).map((s) => s.spec);

test('변이 ① require(문자열) 도 런타임 결합으로 잡는다', () => {
  expect(runtime(`const { f } = require('../tool-runtime/pty-recording-runtimes.js');`)).toContain('../tool-runtime/pty-recording-runtimes.js');
  expect(runtime(`const m = require("../session/x.js") as typeof import('../session/x.js');`)).toContain('../session/x.js');
});

test('변이 ② walkSources 는 .ts 와 .tsx 를 모두 훑고 .d.ts 아닌 다른 확장은 거른다', () => {
  const root = mkdtempSync(join(tmpdir(), 'boundary-scan-'));
  try {
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'a.ts'), '');
    writeFileSync(join(root, 'sub', 'b.tsx'), '');
    writeFileSync(join(root, 'c.md'), '');
    expect(walkSources(root).map((p) => p.slice(root.length + 1)).sort()).toEqual(['a.ts', join('sub', 'b.tsx')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('변이 ③ type-only 판별은 import 문 단위 — 같은 경로의 런타임 import 를 건너뛰지 않는다', () => {
  const text = `import type { A } from '../els/address.js';\nimport { b } from '../els/address.js';\n`;
  expect(scanImports(text)).toEqual([
    { spec: '../els/address.js', typeOnly: true, kind: 'static' },
    { spec: '../els/address.js', typeOnly: false, kind: 'static' },
  ]);
  expect(runtime(text)).toEqual(['../els/address.js']);
});

test('타입 전용은 계속 허용 — import type · typeof import(...)', () => {
  expect(runtime(`import type { A } from '../session/a.js';\ntype T = typeof import('../session/b.js');`)).toEqual([]);
});

const els = (text: string) => tallyImports([{ path: 'src/cli/els-cli.ts', text }], (s) => /^(\.\.\/)+els\//.test(s.spec));
const BASE = { 'src/cli/els-cli.ts|../els/client.js|static': 1 };

test('기준선 — 현재 건수와 같으면 통과, 줄면 under 로 안내', () => {
  expect(compareToBaseline(els(`import { a } from '../els/client.js';`), BASE)).toEqual({ over: [], under: [] });
  expect(compareToBaseline(els(`const x = 1;`), BASE)).toEqual({ over: [], under: ['src/cli/els-cli.ts|../els/client.js|static'] });
});

test('변이 A — 기준선 파일에 새 specifier import 를 더하면 초과', () => {
  const text = `import { a } from '../els/client.js';\nimport '../els/core.js';`;
  expect(compareToBaseline(els(text), BASE).over).toEqual(['src/cli/els-cli.ts|../els/core.js|side-effect']);
});

test('변이 B — 기준선 specifier 를 같은 파일에 한 번 더 쓰면 초과', () => {
  const text = `import { a } from '../els/client.js';\nconst m = require('../els/client.js');\nimport { b } from '../els/client.js';`;
  expect(compareToBaseline(els(text), BASE).over.sort()).toEqual([
    'src/cli/els-cli.ts|../els/client.js|require',
    'src/cli/els-cli.ts|../els/client.js|static',
  ]);
});

// RED-first(#121363/#121367 mustFix · 안2) — 현 래칫(tallyImports)은 표기 패턴만 세고 해석 후 목적지를 안 본다.
// 동적 import 패턴: 현행 head 에 export 가 없어도 이 it 만 RED 로 떨어진다 — 파일 나머지 시험은
// 정적 import(모두 현행 export) 로 그대로 도는다.
describe('안2 — agentEventElsImports: 해석 후 실제 목적지 확인 동등 검증(#121363/#121367 mustFix)', () => {
  it('RED: 중립 규약 파일의 우회 표기 금지 목적지(src/els) 1건 — 래칫 문자 패턴 밖이어도 목적지로 잡는다', async () => {
    const file = { path: 'src/agent-events/emit.ts', text: "import { x } from '../tui/../els/protocol.js';" };
    const mod: any = await import('./boundary-scan.js');
    expect(typeof mod.agentEventElsImports).toBe('function'); // ← 현행 head엔 export가 없어 이 줄에서 RED
    // 갭의 대조 증거: 현 래칫 문자 패턴 ^(..\/)+els(\/|$) 은 ../tui/ 가 끼어 이 우회 표기를 0건으로 센다.
    expect(Object.keys(tallyImports([file], (s) => /^(..\/)+els(\/|$)/.test(s.spec)))).toEqual([]);
    // 요구되는 보증: 해석하면 목적지(src/els/protocol.js) — `${file.path}: ${spec}` 1건.
    expect(mod.agentEventElsImports([file])).toEqual(['src/agent-events/emit.ts: ../tui/../els/protocol.js']);
  });
});
