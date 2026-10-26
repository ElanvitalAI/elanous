import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ptyAvailable, startPty, type PtyHandle } from '../src/pty-shell/registry.js';
import { SYNCHRONIZED_OUTPUT_BEGIN, SYNCHRONIZED_OUTPUT_END } from '../src/dashboard/synchronized-frame-output.js';

const repoRoot = resolve(import.meta.dir, '..');
const handles: PtyHandle[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) {
    if (handle.isAlive()) handle.kill();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function count(text: string, token: string): number {
  return text.split(token).length - 1;
}

async function waitFor(label: string, predicate: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function launchDashboard(root: string, failOnNextFrame: boolean): PtyHandle {
  const state = join(root, 'state');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    onboarding: { completed: true },
    errorReports: { enabled: false },
    llm: { provider: 'local', model: 'test-model' },
    mcp: { enabled: false },
  }));
  const readyFile = join(root, 'ready');
  const armFile = join(root, 'arm-next-frame');
  const errorFile = join(root, 'draw-error');
  const scriptPath = join(root, 'dashboard-child.ts');
  const dashboardPath = JSON.stringify(join(repoRoot, 'src/dashboard/index.ts'));
  const configPath = JSON.stringify(join(repoRoot, 'src/elanous-config-dir.ts'));
  const begin = JSON.stringify(SYNCHRONIZED_OUTPUT_BEGIN);
  const end = JSON.stringify(SYNCHRONIZED_OUTPUT_END);
  const failurePatch = failOnNextFrame ? `
    const originalWrite = process.stdout.write.bind(process.stdout);
    let throwNextFrameBodyWrite = false;
    process.stdout.write = ((chunk, ...args) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      if (existsSync(${JSON.stringify(armFile)}) && text.includes(${begin})) throwNextFrameBodyWrite = true;
      else if (throwNextFrameBodyWrite && text !== ${end}) {
        throwNextFrameBodyWrite = false;
        writeFileSync(${JSON.stringify(errorFile)}, 'injected frame-body write failure');
        throw new Error('injected frame-body write failure');
      }
      return originalWrite(chunk, ...args);
    }) as typeof process.stdout.write;
    process.on('uncaughtException', error => {
      if (!existsSync(${JSON.stringify(errorFile)})) writeFileSync(${JSON.stringify(errorFile)}, String(error));
    });
  ` : '';
  writeFileSync(scriptPath, `
    import { showDashboard } from ${dashboardPath};
    import { setElanousConfigDir } from ${configPath};
    import { existsSync, writeFileSync } from 'node:fs';
    setElanousConfigDir(${JSON.stringify(root)});
    function installFailurePatch() { ${failurePatch} }
    void showDashboard({ onFirstFrameRendered: () => {
      ${failOnNextFrame ? 'installFailurePatch();' : ''}
      writeFileSync(${JSON.stringify(readyFile)}, 'first-frame');
    } })
      .catch(error => { writeFileSync(${JSON.stringify(errorFile)}, String(error)); process.exitCode = 1; });
  `);
  const handle = startPty({
    cmd: 'bun',
    args: [scriptPath],
    workdir: repoRoot,
    cols: 100,
    rows: 30,
    env: {
      ...process.env as Record<string, string>,
      HOME: root,
      ELANOUS_STATE_DIR: state,
      ELANOUS_STATE_DIR_SOURCE: 'explicit',
      ELANOUS_DATA_DIR: join(root, 'data'),
      ELANOUS_SKIP_LOGIN_ENV: '1',
      ELANOUS_SYNC_OUTPUT: 'on',
      TERM: 'xterm-256color',
      COLUMNS: '100',
      LINES: '30',
    },
    unsetEnv: ['ELANOUS_TEST_FAKE_LLM', 'XDG_CONFIG_HOME', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY'],
  });
  handles.push(handle);
  return handle;
}

test('생산 showDashboard 경로에서 첫 프레임과 resize force 프레임이 실제 PTY 출력 안에서 닫힌다', async () => {
  if (!ptyAvailable()) return;
  const root = mkdtempSync(join(tmpdir(), 'dashboard-sync-draw-'));
  roots.push(root);
  const pty = launchDashboard(root, false);
  await waitFor('first dashboard frame', () => existsSync(join(root, 'ready')));
  const beforeForce = pty.snapshot();
  const beforeScreen = await pty.renderScreen();
  const beforePairs = count(beforeForce, SYNCHRONIZED_OUTPUT_BEGIN);
  expect(beforePairs).toBeGreaterThan(0);
  expect(count(beforeForce, SYNCHRONIZED_OUTPUT_END)).toBe(beforePairs);

  // A real terminal resize follows the production forced-redraw listener.
  pty.resize(101, 30);
  await waitFor('forced resize frame', () => count(pty.snapshot(), SYNCHRONIZED_OUTPUT_BEGIN) > beforePairs);
  const afterForce = pty.snapshot();
  const afterScreen = await pty.renderScreen();
  const beginCount = count(afterForce, SYNCHRONIZED_OUTPUT_BEGIN);
  expect(beginCount).toBeGreaterThan(beforePairs);
  expect(count(afterForce, SYNCHRONIZED_OUTPUT_END)).toBe(beginCount);
  expect(afterScreen.length).toBeGreaterThan(0);
  expect(beforeScreen.length).toBeGreaterThan(0);

  writeFileSync(join(root, 'snapshot-before.txt'), beforeScreen);
  writeFileSync(join(root, 'snapshot-after-force.txt'), afterScreen);
  const evidenceDir = process.env.ELANOUS_FLICKER_LIVE_OUT;
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, 'draw-before-screen.txt'), beforeScreen);
    writeFileSync(join(evidenceDir, 'draw-after-resize-screen.txt'), afterScreen);
    writeFileSync(join(evidenceDir, 'draw-before-bytes.txt'), beforeForce);
    writeFileSync(join(evidenceDir, 'draw-after-resize-bytes.txt'), afterForce);
  }
  expect(afterForce.indexOf(SYNCHRONIZED_OUTPUT_BEGIN)).toBeLessThan(afterForce.indexOf(SYNCHRONIZED_OUTPUT_END));
  console.log(`DASHBOARD_SYNC_LIVE frames-before=${beforePairs} frames-after-resize=${beginCount} before-screen=${beforeScreen.length} after-screen=${afterScreen.length}`);
  pty.write('\x11'); // Ctrl+Q
});

test('생산 resize draw가 프레임 본문 write 예외 뒤에도 synchronized region을 닫는다', async () => {
  if (!ptyAvailable()) return;
  const root = mkdtempSync(join(tmpdir(), 'dashboard-sync-draw-fail-'));
  roots.push(root);
  const pty = launchDashboard(root, true);
  try {
    await waitFor('first dashboard frame', () => existsSync(join(root, 'ready')));
  } catch (error) {
    throw new Error(`${String(error)}; dashboard-screen=${await pty.renderScreen()}; output-tail=${pty.snapshot().slice(-2000)}`);
  }
  console.log('DASHBOARD_SYNC_EXCEPTION checkpoint=first-frame');
  const before = pty.snapshot();
  writeFileSync(join(root, 'arm-next-frame'), 'arm');
  pty.resize(102, 30);
  await waitFor('injected draw failure', () => existsSync(join(root, 'draw-error')));
  console.log('DASHBOARD_SYNC_EXCEPTION checkpoint=injected');
  await waitFor('exception frame closure', () => {
    const output = pty.snapshot();
    return count(output, SYNCHRONIZED_OUTPUT_END) > count(before, SYNCHRONIZED_OUTPUT_END);
  });
  console.log('DASHBOARD_SYNC_EXCEPTION checkpoint=closed');
  const after = pty.snapshot();
  const exceptionScreen = await pty.renderScreen();
  expect(readFileSync(join(root, 'draw-error'), 'utf8')).toContain('injected frame-body write failure');
  expect(count(after, SYNCHRONIZED_OUTPUT_BEGIN)).toBe(count(after, SYNCHRONIZED_OUTPUT_END));
  expect(exceptionScreen).toContain('elanous');
  const evidenceDir = process.env.ELANOUS_FLICKER_LIVE_OUT;
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, 'draw-before-exception-bytes.txt'), before);
    writeFileSync(join(evidenceDir, 'draw-after-exception-bytes.txt'), after);
    writeFileSync(join(evidenceDir, 'draw-after-exception-screen.txt'), exceptionScreen);
    writeFileSync(join(evidenceDir, 'draw-error.txt'), readFileSync(join(root, 'draw-error'), 'utf8'));
  }
  console.log(`DASHBOARD_SYNC_EXCEPTION closed=${count(after, SYNCHRONIZED_OUTPUT_END) - count(before, SYNCHRONIZED_OUTPUT_END)} screen=${exceptionScreen.length}`);
  pty.write('\x11'); // Ctrl+Q
}, 60_000);
