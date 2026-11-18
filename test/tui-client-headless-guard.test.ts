// UI-Core arc Phase U3 — headless-core guard.
//
// Enforces: ACP server path (src/acp/server.ts and `tui-client/*`
// directly) may not import TUI / dashboard / chat rendering code. If
// it does, "run Core as a headless daemon" regresses from a
// structural guarantee to a best-effort claim.
//
// This test is a static source scan — no runtime boot. It reads the
// files literally and greps their import specifiers against the
// `headless-core-guard`'s forbidden list.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';

import {
  findForbiddenImports,
  HEADLESS_CORE_DEFAULT_FORBIDDEN,
} from '../src/tui-client/headless-core-guard.js';

const REPO_ROOT = joinPath(import.meta.dir, '..');

function readModule(relPath: string): string {
  return readFileSync(joinPath(REPO_ROOT, relPath), 'utf-8');
}

describe('headless-core guard — ACP server side stays TUI-free', () => {
  test('src/acp/server.ts has no forbidden imports', () => {
    const source = readModule('src/acp/server.ts');
    const hits = findForbiddenImports(source);
    expect(hits).toEqual([]);
  });

  test('src/acp/elanous-extensions.ts has no forbidden imports', () => {
    const source = readModule('src/acp/elanous-extensions.ts');
    const hits = findForbiddenImports(source);
    expect(hits).toEqual([]);
  });

  test('src/acp/capabilities.ts has no forbidden imports', () => {
    const source = readModule('src/acp/capabilities.ts');
    const hits = findForbiddenImports(source);
    expect(hits).toEqual([]);
  });

  test('src/boot/acp-server.ts has no forbidden imports', () => {
    // U4b Step 3 — boot module wires the ACP server CLI path.
    // Keeping it TUI-free is what lets `elanous --acp-server` run
    // as a headless daemon via launchd / systemd.
    const source = readModule('src/boot/acp-server.ts');
    // The guard's default forbidden prefixes assume `../something/`
    // paths from the acp/ or tui-client/ folder. Boot lives one
    // level down, so its own dashboard import would look like
    // `../dashboard/`. The default list already catches that.
    const hits = findForbiddenImports(source);
    expect(hits).toEqual([]);
  });

  test('src/acp/core-turn-bridge.ts has no forbidden imports', () => {
    // U3b Step 2 — the bridge sits between runCoreTurn and the ACP
    // server. It must stay on the "core" side of the headless
    // boundary; leaking dashboard/tui imports here would cancel
    // the point of routing the ACP runTurn through this path.
    const source = readModule('src/acp/core-turn-bridge.ts');
    const hits = findForbiddenImports(source);
    expect(hits).toEqual([]);
  });

  test('src/session-store/ modules have no forbidden imports', () => {
    const modules = [
      'src/session-store/events.ts',
      'src/session-store/shape.ts',
      'src/session-store/facade.ts',
      'src/session-store/index.ts',
    ];
    for (const rel of modules) {
      const hits = findForbiddenImports(readModule(rel));
      expect([rel, hits]).toEqual([rel, []]);
    }
  });

  test('src/core-turn/ modules have no forbidden imports', () => {
    // U3b Step 1 — runCoreTurn is dashboard-free by construction.
    // Step 2 wires it into acp/server.ts runTurn, so any regression
    // here would leak dashboard state into the ACP path before the
    // 3-client ports (Web/iPhone/iPad) even boot.
    const modules = [
      'src/core-turn/types.ts',
      'src/core-turn/run-core-turn.ts',
      'src/core-turn/index.ts',
    ];
    // 2026-11-18 TURN-ROUTE-PIN #38006 — 코어 턴은 core 단위테스트 소유의 순수 핀 모듈만 참조한다
    // (플러그인 의존성 주입 지점 · TUI/dashboard 렌더러 아님 · findForbiddenImports 화이트리스트 밖 신규 계층).
    const allowed = new Set(['../plugins/core/turn-route-pin.js']);
    for (const rel of modules) {
      const hits = findForbiddenImports(readModule(rel)).filter((hit) => !allowed.has(hit));
      expect([rel, hits]).toEqual([rel, []]);
    }
  });

  test('src/tui-client/ modules have no forbidden imports (self-check)', () => {
    // The tui-client scaffold itself is BY DESIGN part of the
    // "reference client" — but to keep the boundary honest the
    // scaffold must not reach back into the dashboard either. When
    // consumers (future dashboard / web / iphone) plug a handler in,
    // they bring their own renderer through the ElanousUiHandler
    // interface — tui-client never `import`s a renderer.
    const modules = [
      'src/tui-client/acp-transport-local.ts',
      'src/tui-client/elanous-ui-handler.ts',
      'src/tui-client/headless-core-guard.ts',
      'src/tui-client/index.ts',
      // U3b Step 3 scaffold additions — in-process transport
      // + DashboardSession. All must stay TUI-free so the scaffold
      // can actually boot the ACP core headless.
      'src/tui-client/in-process-transport.ts',
      'src/tui-client/dashboard-session.ts',
      // Hermes-ACP lessons §5 — stdio discipline lint module.
      'src/tui-client/acp-stdio-discipline.ts',
      // MVP M1.1 — unix-socket client peer for daemon attach.
      'src/tui-client/acp-transport-unix-client.ts',
    ];
    for (const rel of modules) {
      const hits = findForbiddenImports(readModule(rel));
      expect([rel, hits]).toEqual([rel, []]);
    }
  });

  test('src/boot/daemon-runtime.ts has no forbidden imports', () => {
    // MVP M1.3 — daemon's runTurn helper. Composes core-turn-bridge +
    // an in-memory history. Must stay TUI-free so the daemon process
    // is genuinely headless. (M1.5 follow-up will swap the in-memory
    // store for a disk-backed one.)
    const source = readModule('src/boot/daemon-runtime.ts');
    const hits = findForbiddenImports(source);
    expect(hits).toEqual([]);
  });

  // MVP M3 + M5 daemon-http-server + daemon-public-server guards were
  // removed by the C-4e final scrub (PR #1952) — both modules were
  // deleted and their handlers lifted into NEXUS meta-API. NEXUS HTTP
  // server's TUI-free guard lives in nexus-headless-* test families.

  test('src/boot/daemon-tools/* have no forbidden imports', () => {
    // M1.5 A.2 — daemon-side read-only tool surface (Read · Grep ·
    // WebSearch). Lives next to daemon-runtime; must stay TUI-free
    // so the headless daemon can run with an active tool surface
    // without dragging in dashboard rendering.
    const modules = [
      'src/boot/daemon-tools/types.ts',
      'src/boot/daemon-tools/path-guard.ts',
      'src/boot/daemon-tools/read.ts',
      'src/boot/daemon-tools/grep.ts',
      'src/boot/daemon-tools/web-search.ts',
      'src/boot/daemon-tools/index.ts',
    ];
    for (const rel of modules) {
      const hits = findForbiddenImports(readModule(rel));
      expect([rel, hits]).toEqual([rel, []]);
    }
  });
});

describe('findForbiddenImports — unit', () => {
  test('flags dashboard imports', () => {
    const src = `import { foo } from '../dashboard/index.js';`;
    expect(findForbiddenImports(src)).toEqual(['../dashboard/index.js']);
  });

  test('flags tui imports', () => {
    const src = `import { C, ansi } from '../tui.js';`;
    expect(findForbiddenImports(src)).toEqual(['../tui.js']);
  });

  test('passes benign imports', () => {
    const src = `
      import { foo } from 'node:path';
      import { bar } from '../src/acp/client.js';
      import { baz } from '../src/session-store/index.js';
    `;
    expect(findForbiddenImports(src)).toEqual([]);
  });

  test('catches re-exports', () => {
    const src = `export { foo } from '../dashboard/foo.js';`;
    expect(findForbiddenImports(src)).toEqual(['../dashboard/foo.js']);
  });

  test('catches dynamic import()', () => {
    const src = `const m = await import('../chat/index.js');`;
    expect(findForbiddenImports(src)).toEqual(['../chat/index.js']);
  });

  test('catches side-effect-only import', () => {
    const src = `import '../dashboard/index.js';`;
    expect(findForbiddenImports(src)).toEqual(['../dashboard/index.js']);
  });

  test('ignores import-shaped text inside strings', () => {
    const src = `const s = "import '../dashboard/x.js';";`;
    expect(findForbiddenImports(src)).toEqual([]);
  });

  test('ignores import-shaped text inside template literal text', () => {
    const src = "const s = `import '../dashboard/x.js';`;";
    expect(findForbiddenImports(src)).toEqual([]);
  });

  test('catches dynamic import after regex literal containing quote', () => {
    const src = `const r = /'/; await import('../dashboard/x.js');`;
    expect(findForbiddenImports(src)).toEqual(['../dashboard/x.js']);
  });

  test('catches dynamic import inside template expression', () => {
    const src = "const s = `${await import('../dashboard/x.js')}`;";
    expect(findForbiddenImports(src)).toEqual(['../dashboard/x.js']);
  });

  test('forbidden list is non-empty', () => {
    expect(HEADLESS_CORE_DEFAULT_FORBIDDEN.length).toBeGreaterThan(5);
  });
});
