import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanImports, walkSources } from './boundary-scan.js';

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
    { spec: '../els/address.js', typeOnly: true },
    { spec: '../els/address.js', typeOnly: false },
  ]);
  expect(runtime(text)).toEqual(['../els/address.js']);
});

test('타입 전용은 계속 허용 — import type · typeof import(...)', () => {
  expect(runtime(`import type { A } from '../session/a.js';\ntype T = typeof import('../session/b.js');`)).toEqual([]);
});
