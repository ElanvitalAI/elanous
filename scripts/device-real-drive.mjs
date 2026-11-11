#!/usr/bin/env node
// Capture and drive a single explicitly selected physical device for the Q-1 checklist.
// Android uses adb -s; iOS uses Appium's W3C WebDriver endpoint and XCUITest.
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const runFile = promisify(execFile);
const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const has = (name) => args.includes(name);
const platform = value('--platform', '');
const udid = value('--udid', '');
const stage = value('--stage', 'baseline');
const checklistStages = ['phone-link', 'first-chat', 'home', 'notes', 'share', 'duo-fold', 'duo-unfold'];
const label = value('--label', '');
const typedText = value('--type', '');
const expected = value('--expect', '');
const appiumUrl = value('--appium-url', 'http://127.0.0.1:4723');
const bundleId = value('--bundle-id', 'com.elanvitalai.elanous.ios');
const teamId = value('--team-id', 'Y63SK8QGAQ');
const evidenceRoot = value('--evidence-dir', join(homedir(), 'elanous-hq/seat-state/Q-1/evidence'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const safeName = (s) => s.replace(/[^a-zA-Z0-9._-]/g, '-');
const outDir = join(evidenceRoot, `${platform}-${safeName(udid || 'missing')}-${safeName(stage)}-${stamp}`);

function usage() {
  console.log(`Usage:
  device-real-drive.mjs --platform android --udid 192.168.0.156:5555 [--stage first-chat] [--label LABEL] [--type TEXT]
  device-real-drive.mjs --platform ios --udid DEVICE_UDID [--stage first-chat] [--bundle-id ID] [--label LABEL] [--type TEXT]

Stages: phone-link, first-chat, home, notes, share, duo-fold, duo-unfold, or baseline.
Every run saves a screenshot, accessibility tree, and a redacted JSON result under --evidence-dir.
Interactions require an explicit --label. Android interactions require the Elanous app to retain focus before each action.`);
}

async function command(bin, argv, options = {}) {
  try {
    return await runFile(bin, argv, { maxBuffer: 16 * 1024 * 1024, ...options });
  } catch (error) {
    const detail = error.stderr?.trim() || error.stdout?.trim() || error.message;
    throw new Error(`${bin} ${argv.join(' ')} failed: ${detail}`);
  }
}

async function save(name, data) {
  await writeFile(join(outDir, name), data);
}

async function androidRun() {
  const adb = (...argv) => command('adb', ['-s', udid, ...argv]);
  const assertForegroundApp = async () => {
    const dump = (await adb('shell', 'dumpsys', 'window')).stdout;
    const current = dump.match(/mCurrentFocus=.*$/m)?.[0];
    if (!current || !current.includes('com.elanvitalai.elanous.android')) {
      throw new Error(`Refusing interaction: expected Elanous Android app focus, got ${current ?? 'unknown focus'}`);
    }
  };
  const model = (await adb('shell', 'getprop', 'ro.product.model')).stdout.trim();
  const release = (await adb('shell', 'getprop', 'ro.build.version.release')).stdout.trim();
  const focusDump = (await adb('shell', 'dumpsys', 'window')).stdout;
  const focus = focusDump.match(/mCurrentFocus=.*$/m)?.[0] ?? 'mCurrentFocus=unknown';
  const systemUiFocused = !focus.includes('com.elanvitalai.elanous.android');
  const xmlPath = '/sdcard/q1-device-real-drive.xml';
  await adb('shell', 'uiautomator', 'dump', xmlPath);
  const tree = (await adb('shell', 'cat', xmlPath)).stdout;
  const png = await command('adb', ['-s', udid, 'exec-out', 'screencap', '-p'], { encoding: 'buffer' });
  await save('screen.png', png.stdout);
  await save('accessibility.xml', tree);

  let interaction = 'capture-only';
  if (label || typedText) {
    if (!label) throw new Error('--type requires --label to identify the focused text field');
    if (typedText && !/^[a-zA-Z0-9._@-]+(?: [a-zA-Z0-9._@-]+)*$/.test(typedText)) {
      throw new Error('Android text entry only accepts letters, digits, spaces, dot, underscore, @, and hyphen to avoid remote-shell metacharacters.');
    }
    await assertForegroundApp();
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const node = tree.match(new RegExp(`<node\\b(?=[^>]*(?:text|content-desc)="${escaped}")[^>]*>`));
    const bounds = node?.[0].match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bounds) throw new Error(`No visible accessibility node exactly matches label: ${label}`);
    const [, x1, y1, x2, y2] = bounds;
    await assertForegroundApp();
    await adb('shell', 'input', 'tap', String(Math.round((Number(x1) + Number(x2)) / 2)), String(Math.round((Number(y1) + Number(y2)) / 2)));
    if (typedText) {
      await assertForegroundApp();
      await adb('shell', 'input', 'text', typedText.replace(/ /g, '%s'));
    }
    interaction = typedText ? 'tap-and-type' : 'tap';
    await adb('shell', 'uiautomator', 'dump', xmlPath);
    const updatedTree = (await adb('shell', 'cat', xmlPath)).stdout;
    const afterPng = await command('adb', ['-s', udid, 'exec-out', 'screencap', '-p'], { encoding: 'buffer' });
    await save('after-screen.png', afterPng.stdout);
    await save('after-accessibility.xml', updatedTree);
  }
  return { platform, udid, model, osVersion: release, stage, focus, interaction, lockedOrSystemUi: systemUiFocused };
}

async function iosRun() {
  let server;
  let sessionBase;
  try {
    if (has('--start-server')) {
      server = spawn('appium', ['--address', '127.0.0.1', '--port', '4723'], { stdio: ['ignore', 'ignore', 'ignore'] });
      const startup = (async () => {
        const started = Date.now();
        while (Date.now() - started < 30_000) {
          if (server.exitCode !== null) throw new Error('Appium server exited before it became ready');
          try {
            const status = await fetch(`${appiumUrl}/status`);
            if (status.ok) return;
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        throw new Error('Timed out waiting for Appium at /status');
      })();
      await Promise.race([startup, once(server, 'error').then(([error]) => { throw error; })]);
    }

    const response = await fetch(`${appiumUrl}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capabilities: { alwaysMatch: {
        platformName: 'iOS',
        'appium:automationName': 'XCUITest',
        'appium:udid': udid,
        'appium:bundleId': bundleId,
        'appium:noReset': true,
        'appium:autoAcceptAlerts': false,
        'appium:xcodeOrgId': teamId,
        'appium:xcodeSigningId': 'iPhone Developer',
        'appium:updatedWDABundleId': 'com.elanvital.WebDriverAgentRunner',
        'appium:newCommandTimeout': 180,
      } } }),
    });
    const sessionBody = await response.json();
    if (!response.ok || sessionBody.value?.error) throw new Error(`Appium session failed: ${JSON.stringify(sessionBody.value ?? sessionBody)}`);
    const sessionId = sessionBody.value?.sessionId ?? sessionBody.sessionId;
    sessionBase = `${appiumUrl}/session/${sessionId}`;
    const wd = async (path, init) => {
      const r = await fetch(`${sessionBase}${path}`, init);
      const b = await r.json();
      if (!r.ok || b.value?.error) throw new Error(`WebDriver ${path}: ${JSON.stringify(b.value ?? b)}`);
      return b.value;
    };

    const beforeSource = await wd('/source');
    await save('before-accessibility.xml', beforeSource);
    const beforeScreenshot = await wd('/screenshot');
    await save('before-screen.png', Buffer.from(beforeScreenshot, 'base64'));
    if (label) {
      const element = await wd('/element', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ using: 'accessibility id', value: label }) });
      const id = element.ELEMENT ?? element['element-6066-11e4-a52e-4f735466cecf'];
      if (!id) throw new Error(`Appium returned no element id for label: ${label}`);
      if (typedText) await wd(`/element/${id}/value`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: typedText, value: [...typedText] }) });
      else await wd(`/element/${id}/click`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    }
    const afterSource = await wd('/source');
    await save('accessibility.xml', afterSource);
    if (expected && !afterSource.includes(expected)) throw new Error(`Expected accessibility text not present after stage ${stage}: ${expected}`);
    const screenshot = await wd('/screenshot');
    await save('screen.png', Buffer.from(screenshot, 'base64'));
    return { platform, udid, bundleId, stage, interaction: label ? (typedText ? 'type' : 'tap') : 'capture-only', expectedMatched: expected ? afterSource.includes(expected) : null };
  } finally {
    if (sessionBase) await fetch(sessionBase, { method: 'DELETE' }).catch(() => {});
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
      if (server.exitCode === null) server.kill('SIGKILL');
    }
  }
}

if (has('--help')) {
  usage();
  process.exit(0);
}
if (!platform || !udid || !['ios', 'android'].includes(platform) || (stage !== 'baseline' && !checklistStages.includes(stage)) || (typedText && !label)) {
  usage();
  process.exit(2);
}

await mkdir(outDir, { recursive: true });
let result;
try {
  result = platform === 'android' ? await androidRun() : await iosRun();
  if (expected && platform === 'android') {
    const tree = await readFile(join(outDir, label || typedText ? 'after-accessibility.xml' : 'accessibility.xml'), 'utf8');
    result.expectedMatched = tree.includes(expected);
    if (!result.expectedMatched) throw new Error(`Expected accessibility text not present at stage ${stage}: ${expected}`);
  }
  await save('checklist.json', `${JSON.stringify({
    device: { platform, udid, model: result.model ?? null, osVersion: result.osVersion ?? null },
    stages: checklistStages.map((name) => ({
      name,
      status: name !== stage ? 'pending' : result.lockedOrSystemUi ? 'blocked-device-locked' : result.expectedMatched === false ? 'failed' : 'captured-needs-visual-review',
    })),
  }, null, 2)}\n`);
  await save('result.json', `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ...result, evidenceDir: outDir }, null, 2));
} catch (error) {
  await save('checklist.json', `${JSON.stringify({
    device: { platform, udid },
    stages: checklistStages.map((name) => ({ name, status: name === stage ? 'failed-or-blocked' : 'pending' })),
    error: error.message,
  }, null, 2)}\n`);
  await save('result.json', `${JSON.stringify({ platform, udid, stage, error: error.message }, null, 2)}\n`);
  console.error(`DEVICE DRIVE BLOCKED: ${error.message}\nEvidence: ${outDir}`);
  process.exitCode = 1;
}
