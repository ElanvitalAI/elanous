import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { formatHookOrderReport, sweepHookOrder } from '../scripts/hook-order-sweep.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'hook-order-'));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    const target = join(root, file);
    mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

describe('hook order sweep', () => {
  it('names a hook that sits after a guard clause, and leaves the same hook alone once it is hoisted', async () => {
    const broken = await sweepHookOrder(fixture({
      'apps/pwa/src/Broken.tsx': [
        'import { useCallback, useState } from "react";',
        'export function Broken({ items }: { items: string[] }) {',
        '  const [open, setOpen] = useState(false);',
        '  if (items.length === 0) {',
        '    return <p>empty</p>;',
        '  }',
        '  const onPick = useCallback(() => setOpen(!open), [open]);',
        '  return <button onClick={onPick}>{String(open)}</button>;',
        '}',
      ].join('\n'),
    }));
    expect(broken.violations.map((violation) => [violation.hook, violation.kind, violation.owner]))
      .toEqual([['useCallback', 'after-early-return', 'Broken']]);

    const hoisted = await sweepHookOrder(fixture({
      'apps/pwa/src/Fixed.tsx': [
        'import { useCallback, useState } from "react";',
        'export function Fixed({ items }: { items: string[] }) {',
        '  const [open, setOpen] = useState(false);',
        '  const onPick = useCallback(() => setOpen(!open), [open]);',
        '  if (items.length === 0) {',
        '    return <p>empty</p>;',
        '  }',
        '  return <button onClick={onPick}>{String(open)}</button>;',
        '}',
      ].join('\n'),
    }));
    expect(hoisted.violations).toEqual([]);
    expect(hoisted.hookCallsScanned).toBe(2);
  }, 60_000);

  it('does not mistake a hook that is part of the return statement for a hook after it', async () => {
    // ⛔📏 이 자의 2차판이 여기서 45건을 오탐했다 — `return useQuery(…)` 는 훅이 그 반환문 «안»에 있다.
    const report = await sweepHookOrder(fixture({
      'apps/pwa/src/use-thing.ts': [
        'import { useQuery } from "@tanstack/react-query";',
        'import { useClient } from "./use-client";',
        'export function useThing() {',
        '  const client = useClient();',
        '  return useQuery({ queryKey: ["thing"], queryFn: () => client.get() });',
        '}',
      ].join('\n'),
    }));
    expect(report.violations).toEqual([]);
    expect(report.hookCallsScanned).toBe(2);
    expect(report.ownersScanned).toBe(1);
  }, 60_000);

  it('separates a branched hook from a hook inside a plain nested function, because the repair differs', async () => {
    const report = await sweepHookOrder(fixture({
      'apps/pwa/src/Kinds.tsx': [
        'import { useEffect, useMemo, useState } from "react";',
        'export function Kinds({ on }: { on: boolean }) {',
        '  const [value, setValue] = useState(0);',
        '  if (on) {',
        '    useEffect(() => setValue(1), []);',
        '  }',
        '  const helper = () => useMemo(() => value, [value]);',
        '  return <span>{helper()}</span>;',
        '}',
      ].join('\n'),
    }));
    expect(report.violations.map((violation) => [violation.hook, violation.kind]).sort())
      .toEqual([['useEffect', 'conditional'], ['useMemo', 'nested-function']]);
  }, 60_000);

  it('allows a shared query-options factory when each hook is called at the top level', async () => {
    const report = await sweepHookOrder(fixture({
      'apps/pwa/src/use-logs.ts': [
        'import { useQuery } from "@tanstack/react-query";',
        'export function useLogs() {',
        '  const options = (category: string) => ({ queryKey: [category], queryFn: () => category });',
        '  const runs = useQuery(options("runs"));',
        '  const usage = useQuery(options("usage"));',
        '  return { runs, usage };',
        '}',
      ].join('\n'),
    }));
    expect(report.violations).toEqual([]);
    expect(report.hookCallsScanned).toBe(2);
  }, 60_000);

  it('counts a namespaced hook call, so a gate reading zero is not blind to React.useState', async () => {
    // ⛔📏 무인 리뷰(2026-08-21 · PR #10852)가 낸 지적이다: 식별자 호출만 보면 이 형태가 분모와
    //    위반 검사에서 «둘 다» 빠져 「0 위반」이 거짓이 된다. 이 저장소의 shadcn 컴포넌트가 이 형태를 쓴다.
    const report = await sweepHookOrder(fixture({
      'apps/pwa/src/Namespaced.tsx': [
        'import * as React from "react";',
        'export function Namespaced({ items }: { items: string[] }) {',
        '  const [open, setOpen] = React.useState(false);',
        '  if (items.length === 0) {',
        '    return <p>empty</p>;',
        '  }',
        '  const onPick = React.useCallback(() => setOpen(!open), [open]);',
        '  return <button onClick={onPick}>{String(open)}</button>;',
        '}',
      ].join('\n'),
    }));
    expect(report.hookCallsScanned).toBe(2);
    expect(report.violations.map((violation) => [violation.hook, violation.kind]))
      .toEqual([['useCallback', 'after-early-return']]);
  }, 60_000);

  it('recognises a component that gets its name from an assignment, not only from a const declaration', async () => {
    // ⛔📏 const 선언만 보면 `Subject = (props) => …` 안의 훅이 전부 「중첩 함수」로 오탐된다(실측 3건).
    const report = await sweepHookOrder(fixture({
      'apps/pwa/src/assigned.tsx': [
        'import { useState } from "react";',
        'let Subject: ((props: { n: number }) => unknown) | undefined;',
        'export function install() {',
        '  Subject = ({ n }: { n: number }) => {',
        '    const [value] = useState(n);',
        '    return value;',
        '  };',
        '}',
      ].join('\n'),
    }));
    expect(report.violations).toEqual([]);
    expect(report.hookCallsScanned).toBe(1);
  }, 60_000);

  it('prints the denominator first, keeps imported hook identity unmeasured, and reports elapsed seconds last', async () => {
    const lines = formatHookOrderReport(await sweepHookOrder(fixture({
      'apps/pwa/src/One.tsx': 'import { useState } from "react";\nexport function One() {\n  const [a] = useState(0);\n  return <i>{a}</i>;\n}\n',
    })));
    expect(lines[0]).toMatch(/^\[hook-order\] denominator: hook calls=1; components and custom hooks=1; files=1; ruler=/);
    expect(lines[0]).toContain('scope=apps/pwa/src');
    expect(lines.find((line) => line.includes('imported hook identity'))).toContain('not-measured');
    expect(lines.at(-1)).toMatch(/^\[hook-order\] elapsed: \d+\.\d{2}s$/);
  }, 60_000);

  it('never folds a scope it could not read into zero', async () => {
    const report = await sweepHookOrder(fixture({ 'apps/pwa/src/One.tsx': 'export const one = 1;\n' }), ['apps/pwa/src', 'apps/absent/src']);
    expect(report.scanRoots).toEqual(['apps/pwa/src']);
    expect(report.unavailableScopes).toEqual(['apps/absent/src']);
  }, 60_000);

  it('holds the real PWA at zero hook-order violations, over a denominator that is not degenerate', async () => {
    const report = await sweepHookOrder(resolve(import.meta.dir, '..'));

    // ⭐ 퇴화 검사 — 분모가 0이면 이 자는 아무것도 재고 있지 않고 「0 위반」은 거짓이다.
    expect(report.filesScanned).toBeGreaterThan(100);
    expect(report.ownersScanned).toBeGreaterThan(100);
    expect(report.hookCallsScanned).toBeGreaterThan(500);
    expect(report.unavailableScopes).toEqual([]);

    // ⭐⭐ 이것이 게이트다. 이 부류는 이 저장소에서 «두 번» 앱을 죽였고(2026-05-08 · 2026-08-21),
    //    두 번 다 시험 전부가 초록이었다 — 이 저장소의 PWA 시험은 한 번만 그리기 때문이다.
    //    ⛔ 이 단언이 깨지면 「자가 시끄럽다」가 아니라 「앱이 죽는 자리가 들어왔다」로 읽는다.
    expect(report.violations.map((violation) => `${violation.file}:${violation.line} ${violation.hook} (${violation.kind})`)).toEqual([]);
  }, 120_000);
});
