import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../src/debug/log.js';
import {
  LogStore,
  _resetDefaultLogStoreForTest,
  logsDbPath,
} from '../src/mss/logging/log-store.js';
import { MCP_PROTOCOL_VERSION_LATEST } from '../src/mcp/server.js';
import type { McpHttpFetch } from '../src/mcp/client.js';
import * as cycle from './browser-observe-cycle.js';
import {
  ASIDE_REPL_TOOL,
  BROWSER_OBSERVE_LOG_CATEGORY,
  BROWSER_OBSERVE_OK,
  BROWSER_OBSERVE_UNOBSERVED,
  BROWSER_OBSERVE_WRONG_SCREEN,
  MCP_SESSION_HEADER,
  ELANOUS_PWA_URL,
  _resetBrowserObserveLogSinkForTest,
  buildBrowserObserveReplCode,
  classifyBrowserObserve,
  ensureBrowserObserveLogSink,
  observeBrowserCycle,
  type BrowserObserveMcpRequest,
} from './browser-observe-cycle.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

// 2026-08-24 실측 snapshot(page, {interactive:true}).tree — HTML 이 아닌 접근성 개요.
const ACTUAL_ELANOUS_PWA_TREE = `# note: interactive (clickable / focusable) elements only.
- title: "elanous" [url=http://127.0.0.1:31415/app]
- banner:
  - button "open menu" [ref=e1]: "메뉴"
  - link "LIVE pty:tui:5043 · origin: system" [ref=e2]: "LIVE pty:tui:5043"
  - link "voice" [ref=e3]
  - button "settings" [ref=e4]
- complementary:
  - navigation:
    - link "Terminal — 터미널 + agent dock" [ref=e5]
    - link "Chat — 채팅 (스트리밍 · multimodal · mic)" [ref=e6]
    - link "Showroom — multi-agent 동시 비교 (broadcast · CV-3)" [ref=e7]
    - link "Observatory — subject 관측 (talk · screen · agent)" [ref=e8]
    - link "Autopilot — 미션 지휘 (미션 계보·골 던지기·자율행동·루프)" [ref=e9]
    - link "Scheduler — 예약 잡 인지 (크론·run_via·last_run · registry)" [ref=e12]
`;

const OTHER_PAGE_TREE = `# note: interactive (clickable / focusable) elements only.
- title: "Example Domain" [url=https://example.com/]
- generic:
  - heading "Example Domain" [ref=e1]
  - link "More information..." [ref=e2]
`;

const MCP_SESSION_ID = 'sess-browser-observe-1';

interface JsonRpcPost {
  method: string;
  id?: number;
  params?: Record<string, unknown>;
  headers: Record<string, string>;
}

function jsonHeaders(extra: Record<string, string> = {}): { get(name: string): string | null } {
  const map = new Map(
    Object.entries({ 'content-type': 'application/json', ...extra }).map(([k, v]) => [
      k.toLowerCase(),
      v,
    ]),
  );
  return { get: (name) => map.get(name.toLowerCase()) ?? null };
}

function toolCallEnvelope(tree: unknown, url: unknown): {
  content: Array<{ type: string; text: string }>;
  structuredContent: { tree: unknown; url: unknown };
} {
  const snapshot = { tree, url };
  return {
    content: [{ type: 'text', text: JSON.stringify(snapshot) }],
    structuredContent: snapshot,
  };
}

function createMcpHttpFixture(opts: {
  sessionId?: string;
  tree?: unknown;
  url?: unknown;
  result?: unknown;
  toolError?: { code: number; message: string };
  failInitialize?: Error;
  failToolsCall?: Error;
} = {}): { fetch: McpHttpFetch; posts: JsonRpcPost[]; sessionId: string } {
  const posts: JsonRpcPost[] = [];
  const sessionId = opts.sessionId ?? MCP_SESSION_ID;
  const fetch: McpHttpFetch = async (_url, init) => {
    const req = JSON.parse(init.body) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    posts.push({ method: req.method, id: req.id, params: req.params, headers: init.headers });
    if (req.method === 'initialize') {
      if (opts.failInitialize) throw opts.failInitialize;
      return {
        status: 200,
        headers: jsonHeaders({ [MCP_SESSION_HEADER]: sessionId }),
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION_LATEST,
              capabilities: { tools: {} },
            },
          }),
      };
    }
    if (req.method === 'notifications/initialized') {
      return {
        status: 202,
        headers: jsonHeaders({ [MCP_SESSION_HEADER]: sessionId }),
        text: async () => '',
      };
    }
    if (req.method === 'tools/call') {
      if (opts.failToolsCall) throw opts.failToolsCall;
      if (opts.toolError) {
        return {
          status: 200,
          headers: jsonHeaders({ [MCP_SESSION_HEADER]: sessionId }),
          text: async () =>
            JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              error: opts.toolError,
            }),
        };
      }
      return {
        status: 200,
        headers: jsonHeaders({ [MCP_SESSION_HEADER]: sessionId }),
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result:
              opts.result ??
              toolCallEnvelope(
                opts.tree === undefined ? ACTUAL_ELANOUS_PWA_TREE : opts.tree,
                opts.url === undefined ? ELANOUS_PWA_URL : opts.url,
              ),
          }),
      };
    }
    throw new Error(`unexpected method ${req.method}`);
  };
  return { fetch, posts, sessionId };
}

function toolsCallPost(posts: JsonRpcPost[]): JsonRpcPost {
  const post = posts.find((item) => item.method === 'tools/call');
  if (!post) throw new Error('expected tools/call POST');
  return post;
}

describe('classifyBrowserObserve — 공개 순수 분류', () => {
  test('real accessibility tree and url classify as ok without network', () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      return originalFetch(...args);
    }) as typeof fetch;
    try {
      const result = classifyBrowserObserve({
        tree: ACTUAL_ELANOUS_PWA_TREE,
        url: ELANOUS_PWA_URL,
      });
      expect(result.status).toBe(BROWSER_OBSERVE_OK);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('non-PWA accessibility tree is wrong-screen, not ok', () => {
    const result = classifyBrowserObserve({
      tree: OTHER_PAGE_TREE,
      url: 'https://example.com/',
    });
    expect(result.status).toBe(BROWSER_OBSERVE_WRONG_SCREEN);
    expect(result.status).not.toBe(BROWSER_OBSERVE_OK);
  });

  test('HTML main-role fixture without PWA markers is wrong-screen', () => {
    const htmlGuess = '<main role="main" data-testid="app-shell"><div>hello</div></main>';
    const result = classifyBrowserObserve({
      tree: htmlGuess,
      url: ELANOUS_PWA_URL,
    });
    expect(result.status).toBe(BROWSER_OBSERVE_WRONG_SCREEN);
    expect(result.status).not.toBe(BROWSER_OBSERVE_OK);
  });

  test('unread url is not treated as the expected PWA url', () => {
    const result = classifyBrowserObserve({
      tree: ACTUAL_ELANOUS_PWA_TREE,
      url: null,
    });
    expect(result.status).toBe(BROWSER_OBSERVE_UNOBSERVED);
    expect(result.observedUrl).toBeNull();
    expect(result.observedUrl).not.toBe(ELANOUS_PWA_URL);
    expect(result.reason).toBe('url-unreadable');
  });

  test('empty url string is unobserved, not the expected url', () => {
    const result = classifyBrowserObserve({
      tree: ACTUAL_ELANOUS_PWA_TREE,
      url: '   ',
    });
    expect(result.status).toBe(BROWSER_OBSERVE_UNOBSERVED);
    expect(result.observedUrl).toBeNull();
    expect(result.observedUrl).not.toBe(ELANOUS_PWA_URL);
  });

  test('blank tree is unobserved, not wrong-screen', () => {
    const result = classifyBrowserObserve({
      tree: '   \n',
      url: ELANOUS_PWA_URL,
    });
    expect(result.status).toBe(BROWSER_OBSERVE_UNOBSERVED);
    expect(result.status).not.toBe(BROWSER_OBSERVE_WRONG_SCREEN);
    expect(result.reason).toBe('tree-unreadable');
  });
});

describe('observeBrowserCycle — MCP initialize + session HTTP path', () => {
  test('default transport initializes, forwards Mcp-Session-Id, then tools/call', async () => {
    const fixture = createMcpHttpFixture();
    const result = await observeBrowserCycle({
      fetch: fixture.fetch,
      log: () => {},
    });
    expect(result.status).toBe(BROWSER_OBSERVE_OK);
    expect(fixture.posts.map((post) => post.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    const init = fixture.posts[0];
    expect(init?.headers[MCP_SESSION_HEADER]).toBeUndefined();
    const call = toolsCallPost(fixture.posts);
    expect(call.headers[MCP_SESSION_HEADER]).toBe(fixture.sessionId);
  });

  test('JSON-RPC tools/call envelope with structuredContent classifies as ok', async () => {
    const fixture = createMcpHttpFixture();
    const result = await observeBrowserCycle({
      fetch: fixture.fetch,
      log: () => {},
    });
    expect(result.status).toBe(BROWSER_OBSERVE_OK);
    expect(result.observedUrl).toBe(ELANOUS_PWA_URL);
    const call = toolsCallPost(fixture.posts);
    expect(call.method).toBe('tools/call');
  });

  test('MCP exception is unobserved, distinct from wrong-screen', async () => {
    const result = await observeBrowserCycle({
      mcpCall: async () => {
        throw new Error('ECONNREFUSED');
      },
      log: () => {},
    });
    expect(result.status).toBe(BROWSER_OBSERVE_UNOBSERVED);
    expect(result.status).not.toBe(BROWSER_OBSERVE_WRONG_SCREEN);
    expect(result.observedUrl).toBeNull();
  });

  test('JSON-RPC error envelope after initialize is unobserved, distinct from wrong-screen', async () => {
    const fixture = createMcpHttpFixture({
      toolError: { code: -32603, message: 'aside.repl failed' },
    });
    const result = await observeBrowserCycle({
      fetch: fixture.fetch,
      log: () => {},
    });
    expect(result.status).toBe(BROWSER_OBSERVE_UNOBSERVED);
    expect(result.status).not.toBe(BROWSER_OBSERVE_WRONG_SCREEN);
    expect(result.observedUrl).toBeNull();
    expect(fixture.posts.map((post) => post.method)).toContain('initialize');
    expect(fixture.posts.map((post) => post.method)).toContain('tools/call');
  });

  test('initialize transport failure is unobserved, not wrong-screen', async () => {
    const fixture = createMcpHttpFixture({
      failInitialize: new Error('ECONNREFUSED'),
    });
    const result = await observeBrowserCycle({
      fetch: fixture.fetch,
      log: () => {},
    });
    expect(result.status).toBe(BROWSER_OBSERVE_UNOBSERVED);
    expect(result.status).not.toBe(BROWSER_OBSERVE_WRONG_SCREEN);
    expect(fixture.posts.map((post) => post.method)).toEqual(['initialize']);
  });

  test('blank tree from MCP envelope is unobserved, not wrong-screen', async () => {
    const fixture = createMcpHttpFixture({ tree: '   ', url: ELANOUS_PWA_URL });
    const result = await observeBrowserCycle({
      fetch: fixture.fetch,
      log: () => {},
    });
    expect(result.status).toBe(BROWSER_OBSERVE_UNOBSERVED);
    expect(result.status).not.toBe(BROWSER_OBSERVE_WRONG_SCREEN);
    expect(result.reason).toBe('tree-unreadable');
  });

  test('MCP request body is tools/call aside.repl with title and code', async () => {
    const fixture = createMcpHttpFixture();
    const result = await observeBrowserCycle({
      fetch: fixture.fetch,
      log: () => {},
    });
    const request: BrowserObserveMcpRequest = result.request;
    expect(request.method).toBe('tools/call');
    expect(request.params.name).toBe(ASIDE_REPL_TOOL);
    expect(request.params.name).toBe('aside.repl');
    const argumentKeys = Object.keys(request.params.arguments).sort();
    expect(argumentKeys).toEqual(['code', 'title']);
    expect(typeof request.params.arguments.title).toBe('string');
    expect(typeof request.params.arguments.code).toBe('string');
    const call = toolsCallPost(fixture.posts);
    expect(call.method).toBe('tools/call');
    expect(call.params?.name).toBe('aside.repl');
    const postedArgs = call.params?.arguments as { title?: unknown; code?: unknown } | undefined;
    expect(Object.keys(postedArgs ?? {}).sort()).toEqual(['code', 'title']);
  });

  test('browser code navigates to the elanous PWA address', async () => {
    const fixture = createMcpHttpFixture();
    await observeBrowserCycle({
      fetch: fixture.fetch,
      log: () => {},
    });
    const call = toolsCallPost(fixture.posts);
    const postedArgs = call.params?.arguments as { code?: string } | undefined;
    const code = postedArgs?.code ?? '';
    expect(code).toContain(ELANOUS_PWA_URL);
    expect(code).toContain('http://127.0.0.1:31415/app');
    expect(/openTab\s*\(|page\.goto\s*\(/.test(code)).toBe(true);
  });

  test('unread url from MCP envelope is not treated as the expected PWA url', async () => {
    const fixture = createMcpHttpFixture({
      tree: ACTUAL_ELANOUS_PWA_TREE,
      url: null,
    });
    const result = await observeBrowserCycle({
      fetch: fixture.fetch,
      log: () => {},
    });
    expect(result.status).toBe(BROWSER_OBSERVE_UNOBSERVED);
    expect(result.observedUrl).toBeNull();
    expect(result.observedUrl).not.toBe(ELANOUS_PWA_URL);
  });

  test('non-PWA tree inside tools/call envelope is wrong-screen', async () => {
    const fixture = createMcpHttpFixture({
      tree: OTHER_PAGE_TREE,
      url: 'https://example.com/',
    });
    const result = await observeBrowserCycle({
      fetch: fixture.fetch,
      log: () => {},
    });
    expect(result.status).toBe(BROWSER_OBSERVE_WRONG_SCREEN);
    expect(result.status).not.toBe(BROWSER_OBSERVE_OK);
  });
});

describe('observeBrowserCycle — standalone sink reaches logs.db', () => {
  const temporaryRoots: string[] = [];
  afterEach(() => {
    _resetBrowserObserveLogSinkForTest();
    _resetDefaultLogStoreForTest();
    temporaryRoots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  async function withQueryableLogStore<T>(fn: () => Promise<T>): Promise<T> {
    const nodeEnv = process.env.NODE_ENV;
    const stateDir = process.env.ELANOUS_STATE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'browser-observe-logs-'));
    temporaryRoots.push(dir);
    process.env.NODE_ENV = 'production';
    process.env.ELANOUS_STATE_DIR = dir;
    _resetDefaultLogStoreForTest();
    _resetBrowserObserveLogSinkForTest();
    try {
      const attached = await ensureBrowserObserveLogSink();
      expect(attached).toBe(true);
      return await fn();
    } finally {
      debug.flush();
      _resetBrowserObserveLogSinkForTest();
      _resetDefaultLogStoreForTest();
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      if (stateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = stateDir;
    }
  }

  function queryObserveRows(event: string) {
    const reader = LogStore.openReadOnly(logsDbPath());
    try {
      return reader.query({
        exactCategories: [BROWSER_OBSERVE_LOG_CATEGORY],
        events: [event],
        limit: 20,
      });
    } finally {
      reader.close();
    }
  }

  test('success path records debug.log into logs.db and is re-readable', async () => {
    await withQueryableLogStore(async () => {
      const fixture = createMcpHttpFixture();
      const result = await observeBrowserCycle({
        fetch: fixture.fetch,
      });
      expect(result.status).toBe(BROWSER_OBSERVE_OK);
      debug.flush();
      const rows = queryObserveRows(BROWSER_OBSERVE_OK);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.category).toBe(BROWSER_OBSERVE_LOG_CATEGORY);
      expect(rows[0]?.event).toBe(BROWSER_OBSERVE_OK);
      const data = JSON.parse(rows[0]?.data ?? '{}') as {
        status?: string;
        reason?: string;
        observedUrl?: string | null;
      };
      expect(data.status).toBe(BROWSER_OBSERVE_OK);
      expect(data.reason).toBe('elanous-pwa');
      expect(data.observedUrl).toBe(ELANOUS_PWA_URL);
    });
  });

  test('failure path records debug.log into logs.db and is re-readable', async () => {
    await withQueryableLogStore(async () => {
      const fixture = createMcpHttpFixture({
        failToolsCall: new Error('timeout'),
      });
      const result = await observeBrowserCycle({
        fetch: fixture.fetch,
      });
      expect(result.status).toBe(BROWSER_OBSERVE_UNOBSERVED);
      debug.flush();
      const rows = queryObserveRows(BROWSER_OBSERVE_UNOBSERVED);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.category).toBe(BROWSER_OBSERVE_LOG_CATEGORY);
      expect(rows[0]?.event).toBe(BROWSER_OBSERVE_UNOBSERVED);
      const data = JSON.parse(rows[0]?.data ?? '{}') as {
        status?: string;
        reason?: string;
        observedUrl?: string | null;
      };
      expect(data.status).toBe(BROWSER_OBSERVE_UNOBSERVED);
      expect(data.reason).toContain('mcp-call:');
      expect(data.observedUrl).toBeNull();
    });
  });
});

describe('buildBrowserObserveReplCode — injected browser execution', () => {
  const LEGACY_TOP_LEVEL_RETURN_REPL = [
    `const pwaUrl = ${JSON.stringify(ELANOUS_PWA_URL)};`,
    'const page = await openTab(pwaUrl);',
    'await page.goto(pwaUrl);',
    'await sleep(250);',
    'const snap = await snapshot(page, { interactive: true });',
    'const url = page.url();',
    'return { tree: snap && snap.tree, url: typeof url === "string" && url.length > 0 ? url : null };',
  ].join('\n');

  function lastNonEmptyLine(code: string): string {
    const lines = code.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    return lines[lines.length - 1] ?? '';
  }

  function hasTopLevelConstOrLet(code: string): boolean {
    let depth = 0;
    for (const line of code.split('\n')) {
      const trimmed = line.trim();
      if (depth === 0 && /^(?:const|let)\b/.test(trimmed)) return true;
      for (const ch of line) {
        if (ch === '{') depth += 1;
        else if (ch === '}') depth = Math.max(0, depth - 1);
      }
    }
    return false;
  }

  function withTopLevelConst(code: string): string {
    return `const pwaUrl = ${JSON.stringify(ELANOUS_PWA_URL)};\n${code}`;
  }

  function withTopLevelReturn(code: string): string {
    const lines = code.split('\n');
    lines[lines.length - 1] =
      'return { tree: snap && snap.tree, url: typeof url === "string" && url.length > 0 ? url : null };';
    return lines.join('\n');
  }

  function withoutCloseTab(code: string): string {
    return code
      .replace('  try {\n', '')
      .replace(
        '; } finally { try { await closeTab(p); } catch {} } })();',
        '; })();',
      );
  }

  function expectOpenedTabWasClosed(calls: string[]): void {
    const openIdx = calls.indexOf('openTab');
    const closeIdx = calls.indexOf('closeTab');
    expect(openIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeGreaterThan(openIdx);
  }

  function mcpToolResultFromReplStdout(stdout: string): {
    content: Array<{ type: string; text: string }>;
  } {
    return {
      content: [{ type: 'text', text: stdout }],
    };
  }

  function executeReplCodeInInjectedBrowser(
    code: string,
    tree: string,
    url: string,
    times = 1,
    opts: { snapshotError?: string; closeTabError?: string } = {},
  ): { stdout: string; calls: string[] } {
    const dir = mkdtempSync(join(tmpdir(), 'browser-observe-repl-'));
    const runnerPath = join(dir, 'repl.mjs');
    const copies = Array.from({ length: times }, () => code);
    const snapshotBody = opts.snapshotError
      ? `throw new Error(${JSON.stringify(opts.snapshotError)});`
      : 'return { tree: __fixture.tree, refs: {}, diff: [] };';
    const closeTabBody = opts.closeTabError
      ? `throw new Error(${JSON.stringify(opts.closeTabError)});`
      : 'undefined;';
    const runner = [
      `const __fixture = ${JSON.stringify({ tree, url })};`,
      'const __calls = [];',
      'const openTab = async (_target) => { __calls.push("openTab"); return { goto: async () => undefined, url: () => __fixture.url }; };',
      `const snapshot = async (_page, _opts) => { __calls.push("snapshot"); ${snapshotBody} };`,
      'const sleep = async (_ms) => undefined;',
      `const closeTab = async (_page) => { __calls.push("closeTab"); ${closeTabBody} };`,
      'try {',
      ...copies,
      '} finally { console.log(JSON.stringify({ __calls })); }',
    ].join('\n');
    writeFileSync(runnerPath, runner);
    try {
      const result = spawnSync(process.execPath, [runnerPath], {
        encoding: 'utf8',
        timeout: 8_000,
      });
      const lines = (result.stdout ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      let calls: string[] = [];
      const remaining: string[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as { __calls?: unknown };
          if (Array.isArray(parsed.__calls)) {
            calls = parsed.__calls.map(String);
            continue;
          }
        } catch {
          /* not the call log */
        }
        remaining.push(line);
      }
      if (result.status !== 0 && !opts.snapshotError) {
        const detail = (result.stderr || result.stdout || 'repl failed').trim();
        throw new SyntaxError(detail.split('\n')[0] || 'repl failed');
      }
      return { stdout: remaining[remaining.length - 1] ?? '', calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('generated code has no top-level return and prints tree/url JSON on stdout', () => {
    const code = buildBrowserObserveReplCode();
    expect(/^\s*return\b/m.test(code)).toBe(false);
    const last = lastNonEmptyLine(code);
    expect(last.startsWith('return')).toBe(false);
    expect(last).toContain('console.log');
    expect(last).toContain('JSON.stringify');
    expect(last).toContain('tree');
    expect(last).toContain('url');
  });

  test('injected execution emits tree and url without throwing', () => {
    const code = buildBrowserObserveReplCode();
    const executed = executeReplCodeInInjectedBrowser(
      code,
      ACTUAL_ELANOUS_PWA_TREE,
      ELANOUS_PWA_URL,
    );
    const emitted = JSON.parse(executed.stdout) as { tree?: unknown; url?: unknown };
    expect(emitted.tree).toBe(ACTUAL_ELANOUS_PWA_TREE);
    expect(emitted.url).toBe(ELANOUS_PWA_URL);
  });

  test('top-level return mutation fails at the same injected execution site', () => {
    const mutated = withTopLevelReturn(buildBrowserObserveReplCode());
    expect(/^\s*return\b/m.test(mutated)).toBe(true);
    let failed = false;
    try {
      executeReplCodeInInjectedBrowser(mutated, ACTUAL_ELANOUS_PWA_TREE, ELANOUS_PWA_URL);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  test('legacy top-level return fixture fails at the same injected execution site', () => {
    expect(/^\s*return\b/m.test(LEGACY_TOP_LEVEL_RETURN_REPL)).toBe(true);
    let failed = false;
    try {
      executeReplCodeInInjectedBrowser(
        LEGACY_TOP_LEVEL_RETURN_REPL,
        ACTUAL_ELANOUS_PWA_TREE,
        ELANOUS_PWA_URL,
      );
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  test('stdout JSON from injected execution classifies as ok, not unobserved', async () => {
    const executed = executeReplCodeInInjectedBrowser(
      buildBrowserObserveReplCode(),
      ACTUAL_ELANOUS_PWA_TREE,
      ELANOUS_PWA_URL,
    );
    const envelope = mcpToolResultFromReplStdout(executed.stdout);
    expect(envelope).not.toHaveProperty('tree');
    expect(envelope).not.toHaveProperty('url');
    expect(envelope).not.toHaveProperty('structuredContent');
    expect(envelope.content[0]?.text).toBe(executed.stdout);
    const fixture = createMcpHttpFixture({ result: envelope });
    const result = await observeBrowserCycle({
      fetch: fixture.fetch,
      log: () => {},
    });
    expect(result.status).toBe(BROWSER_OBSERVE_OK);
    expect(result.status).not.toBe(BROWSER_OBSERVE_UNOBSERVED);
    expect(result.observedUrl).toBe(ELANOUS_PWA_URL);
    expect(result.reason).toBe('elanous-pwa');
  });

  test('generated code has no top-level const or let', () => {
    expect(hasTopLevelConstOrLet(buildBrowserObserveReplCode())).toBe(false);
  });

  test('injected persistent scope runs the same code twice without throwing', () => {
    const code = buildBrowserObserveReplCode();
    const executed = executeReplCodeInInjectedBrowser(
      code,
      ACTUAL_ELANOUS_PWA_TREE,
      ELANOUS_PWA_URL,
      2,
    );
    const emitted = JSON.parse(executed.stdout) as { tree?: unknown; url?: unknown };
    expect(emitted.tree).toBe(ACTUAL_ELANOUS_PWA_TREE);
    expect(emitted.url).toBe(ELANOUS_PWA_URL);
  });

  test('reintroducing a top-level const fails the same persistent-scope check', () => {
    const mutated = withTopLevelConst(buildBrowserObserveReplCode());
    expect(hasTopLevelConstOrLet(mutated)).toBe(true);
    let failed = false;
    try {
      executeReplCodeInInjectedBrowser(mutated, ACTUAL_ELANOUS_PWA_TREE, ELANOUS_PWA_URL, 2);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  test('injected execution closes the tab it opened', () => {
    const executed = executeReplCodeInInjectedBrowser(
      buildBrowserObserveReplCode(),
      ACTUAL_ELANOUS_PWA_TREE,
      ELANOUS_PWA_URL,
    );
    expectOpenedTabWasClosed(executed.calls);
  });

  test('snapshot failure still closes the opened tab', () => {
    const executed = executeReplCodeInInjectedBrowser(
      buildBrowserObserveReplCode(),
      ACTUAL_ELANOUS_PWA_TREE,
      ELANOUS_PWA_URL,
      1,
      { snapshotError: 'snapshot failed' },
    );
    expectOpenedTabWasClosed(executed.calls);
  });

  test('closeTab failure keeps a successful observation as ok, not wrong-screen', async () => {
    const executed = executeReplCodeInInjectedBrowser(
      buildBrowserObserveReplCode(),
      ACTUAL_ELANOUS_PWA_TREE,
      ELANOUS_PWA_URL,
      1,
      { closeTabError: 'close failed' },
    );
    expectOpenedTabWasClosed(executed.calls);
    const envelope = mcpToolResultFromReplStdout(executed.stdout);
    const fixture = createMcpHttpFixture({ result: envelope });
    const result = await observeBrowserCycle({
      fetch: fixture.fetch,
      log: () => {},
    });
    expect(result.status).toBe(BROWSER_OBSERVE_OK);
    expect(result.status).not.toBe(BROWSER_OBSERVE_WRONG_SCREEN);
  });

  test('removing closeTab fails the injected cleanup checks', () => {
    const mutated = withoutCloseTab(buildBrowserObserveReplCode());
    expect(mutated).not.toContain('closeTab');
    const success = executeReplCodeInInjectedBrowser(
      mutated,
      ACTUAL_ELANOUS_PWA_TREE,
      ELANOUS_PWA_URL,
    );
    let successCheckFailed = false;
    try {
      expectOpenedTabWasClosed(success.calls);
    } catch {
      successCheckFailed = true;
    }
    expect(successCheckFailed).toBe(true);

    const snapshotFailed = executeReplCodeInInjectedBrowser(
      mutated,
      ACTUAL_ELANOUS_PWA_TREE,
      ELANOUS_PWA_URL,
      1,
      { snapshotError: 'snapshot failed' },
    );
    let snapshotCheckFailed = false;
    try {
      expectOpenedTabWasClosed(snapshotFailed.calls);
    } catch {
      snapshotCheckFailed = true;
    }
    expect(snapshotCheckFailed).toBe(true);
  });
});

describe('observeBrowserCycle — mixed human text plus JSON', () => {
  const ASIDE_REPL_HUMAN_PREFIX =
    '✔︎ Opened a new tab and set it active: tabs[1], page → elanous (http://127.0.0.1:31415/app)';

  test('prefixed result JSON classifies as ok, not unobserved', async () => {
    const mixed = `${ASIDE_REPL_HUMAN_PREFIX}\n${JSON.stringify({
      tree: ACTUAL_ELANOUS_PWA_TREE,
      url: ELANOUS_PWA_URL,
    })}`;
    const fixture = createMcpHttpFixture({
      result: { content: [{ type: 'text', text: mixed }] },
    });
    const result = await observeBrowserCycle({
      fetch: fixture.fetch,
      log: () => {},
    });
    expect(result.status).toBe(BROWSER_OBSERVE_OK);
    expect(result.status).not.toBe(BROWSER_OBSERVE_UNOBSERVED);
    expect(result.observedUrl).toBe(ELANOUS_PWA_URL);
    expect(result.reason).toBe('elanous-pwa');
  });

  test('human-readable prefix without result JSON is unobserved, not wrong-screen', async () => {
    const fixture = createMcpHttpFixture({
      result: { content: [{ type: 'text', text: ASIDE_REPL_HUMAN_PREFIX }] },
    });
    const result = await observeBrowserCycle({
      fetch: fixture.fetch,
      log: () => {},
    });
    expect(result.status).toBe(BROWSER_OBSERVE_UNOBSERVED);
    expect(result.status).not.toBe(BROWSER_OBSERVE_WRONG_SCREEN);
    expect(result.reason).toBe('tree-unreadable');
  });

  test('prefixed result JSON still classifies as ok when the prefix contains braces', async () => {
    const mixed = `✔︎ Opened a new tab {not json} and set it active: tabs[1] {extra}\n${JSON.stringify({
      tree: ACTUAL_ELANOUS_PWA_TREE,
      url: ELANOUS_PWA_URL,
    })}`;
    const fixture = createMcpHttpFixture({
      result: { content: [{ type: 'text', text: mixed }] },
    });
    const result = await observeBrowserCycle({
      fetch: fixture.fetch,
      log: () => {},
    });
    expect(result.status).toBe(BROWSER_OBSERVE_OK);
    expect(result.status).not.toBe(BROWSER_OBSERVE_UNOBSERVED);
    expect(result.observedUrl).toBe(ELANOUS_PWA_URL);
    expect(result.reason).toBe('elanous-pwa');
  });

  test('result JSON after same-line brace noise classifies as ok, not unobserved', async () => {
    const payload = JSON.stringify({
      tree: ACTUAL_ELANOUS_PWA_TREE,
      url: ELANOUS_PWA_URL,
    });
    const mixed = `note {not json} ${payload}`;
    const fixture = createMcpHttpFixture({
      result: { content: [{ type: 'text', text: mixed }] },
    });
    const result = await observeBrowserCycle({
      fetch: fixture.fetch,
      log: () => {},
    });
    expect(result.status).toBe(BROWSER_OBSERVE_OK);
    expect(result.status).not.toBe(BROWSER_OBSERVE_UNOBSERVED);
    expect(result.observedUrl).toBe(ELANOUS_PWA_URL);
  });

  test('trailing nested result JSON after leading braces uses the outer object', async () => {
    const payload = JSON.stringify({
      tree: ACTUAL_ELANOUS_PWA_TREE,
      url: ELANOUS_PWA_URL,
      decoy: { tree: OTHER_PAGE_TREE, url: 'https://example.com/' },
    });
    const mixed = `✔︎ Opened a new tab {not json} and set it active: tabs[1] {extra} ${payload}`;
    const fixture = createMcpHttpFixture({
      result: { content: [{ type: 'text', text: mixed }] },
    });
    const result = await observeBrowserCycle({
      fetch: fixture.fetch,
      log: () => {},
    });
    expect(result.status).toBe(BROWSER_OBSERVE_OK);
    expect(result.status).not.toBe(BROWSER_OBSERVE_UNOBSERVED);
    expect(result.status).not.toBe(BROWSER_OBSERVE_WRONG_SCREEN);
    expect(result.observedUrl).toBe(ELANOUS_PWA_URL);
    expect(result.reason).toBe('elanous-pwa');
  });

  test('pretty-printed nested result JSON after leading braces uses the outer object', async () => {
    const inner = JSON.stringify({ tree: OTHER_PAGE_TREE, url: 'https://example.com/' });
    const payload = [
      '{',
      `  "tree": ${JSON.stringify(ACTUAL_ELANOUS_PWA_TREE)},`,
      `  "url": ${JSON.stringify(ELANOUS_PWA_URL)},`,
      `  "decoy": ${inner}`,
      '}',
    ].join('\n');
    const mixed = `✔︎ Opened a new tab {not json} and set it active: tabs[1] {extra}\n${payload}`;
    const fixture = createMcpHttpFixture({
      result: { content: [{ type: 'text', text: mixed }] },
    });
    const result = await observeBrowserCycle({
      fetch: fixture.fetch,
      log: () => {},
    });
    expect(result.status).toBe(BROWSER_OBSERVE_OK);
    expect(result.status).not.toBe(BROWSER_OBSERVE_UNOBSERVED);
    expect(result.status).not.toBe(BROWSER_OBSERVE_WRONG_SCREEN);
    expect(result.observedUrl).toBe(ELANOUS_PWA_URL);
    expect(result.reason).toBe('elanous-pwa');
  });
});

describe('scripts/browser-observe-cycle.ts exports', () => {
  test('exported names include the pure classifier', () => {
    const names = Object.getOwnPropertyNames(cycle);
    expect(names).toContain('classifyBrowserObserve');
    expect(typeof cycle.classifyBrowserObserve).toBe('function');
  });
});
