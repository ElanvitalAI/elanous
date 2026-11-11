import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./device-real-drive.mjs', import.meta.url));
const root = dirname(script);
const initialTree = '<hierarchy><node text="Send" content-desc="Send" bounds="[0,0][100,100]" /></hierarchy>';
const afterTree = '<hierarchy><node text="Send" content-desc="Send" bounds="[0,0][100,100]" /><node text="after-text" /></hierarchy>';

function fixture(focus = 'mCurrentFocus=Window{u0 com.elanvitalai.elanous.android/.MainActivity}') {
  const dir = mkdtempSync(join(tmpdir(), 'device-real-drive-'));
  const bin = join(dir, 'bin');
  const evidence = join(dir, 'evidence');
  const actions = join(dir, 'actions.log');
  mkdirSync(bin);
  const adb = join(bin, 'adb');
  writeFileSync(adb, `#!/bin/sh
if [ "$1" = "-s" ]; then shift 2; fi
case "$1 $2 $3" in
  "shell getprop ro.product.model") echo SM-F971N ;;
  "shell getprop ro.build.version.release") echo 17 ;;
  "shell dumpsys window") echo '${focus}' ;;
  "shell uiautomator dump") : ;;
  "shell cat /sdcard/q1-device-real-drive.xml")
    if [ -f '${actions}' ]; then printf '%s' '${afterTree}'; else printf '%s' '${initialTree}'; fi
    ;;
  "exec-out screencap -p") printf '\\211PNG\\r\\n\\032\\n' ;;
  "shell input tap"|"shell input text") printf '%s\\n' "$*" >> '${actions}' ;;
  *) exit 2 ;;
esac
`);
  // The fake adb is the only device boundary used by this test.
  chmodSync(adb, 0o755);
  return { dir, bin, evidence, actions, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function invoke(f, args) {
  return spawnSync(process.execPath, [script, ...args, '--evidence-dir', f.evidence], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` },
  });
}

async function startMockAppium(dir) {
  const mock = join(dir, 'mock-appium.mjs');
  writeFileSync(mock, `import { createServer } from 'node:http';
let changed = false;
const send = (res, value = {}) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ value })); };
const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/session') { changed = false; return send(res, { sessionId: 'mock-session' }); }
  if (req.url === '/session/mock-session/source') return send(res, changed ? '<App><Text>after-text</Text></App>' : '<App><Text>before-text</Text></App>');
  if (req.url === '/session/mock-session/screenshot') return send(res, Buffer.from('fake-png').toString('base64'));
  if (req.method === 'POST' && req.url === '/session/mock-session/element') return send(res, { 'element-6066-11e4-a52e-4f735466cecf': 'mock-element' });
  if (req.method === 'POST' && req.url === '/session/mock-session/element/mock-element/value') { changed = true; return send(res); }
  if (req.method === 'POST' && req.url === '/session/mock-session/element/mock-element/click') { changed = true; return send(res); }
  if (req.method === 'DELETE' && req.url === '/session/mock-session') return send(res);
  res.writeHead(404); res.end('{}');
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`);
  const child = spawn(process.execPath, [mock], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('\n')) resolve(output.trim());
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Mock Appium exited early: ${code}`)));
  });
  return { child, url: `http://127.0.0.1:${port}` };
}

function invokeAsync(f, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args, '--evidence-dir', f.evidence], {
      env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (status) => resolve({ status, stdout, stderr }));
  });
}

test('Android driving requires a safe explicit label and checks post-action content', () => {
  const f = fixture();
  try {
    const result = invoke(f, ['--platform', 'android', '--udid', 'fake-device', '--stage', 'first-chat', '--label', 'Send', '--type', 'hello world', '--expect', 'after-text']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(f.actions, 'utf8'), /input tap 50 50/);
    assert.match(readFileSync(f.actions, 'utf8'), /input text hello%sworld/);
    const runDir = join(f.evidence, readdirSync(f.evidence)[0]);
    const resultJson = JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8'));
    assert.equal(resultJson.expectedMatched, true);
  } finally {
    f.cleanup();
  }
});

test('Android rejects shell metacharacters and records failure evidence', () => {
  const f = fixture();
  try {
    const result = invoke(f, ['--platform', 'android', '--udid', 'fake-device', '--stage', 'first-chat', '--label', 'Send', '--type', 'hello;touch /tmp/pwned']);
    assert.equal(result.status, 1);
    assert.equal(existsSync(f.actions), false);
    const runDir = join(f.evidence, readdirSync(f.evidence)[0]);
    const checklist = JSON.parse(readFileSync(join(runDir, 'checklist.json'), 'utf8'));
    assert.equal(checklist.stages.find((item) => item.name === 'first-chat').status, 'failed-or-blocked');
  } finally {
    f.cleanup();
  }
});

test('Android refuses interaction when focus is unknown and records the blocked stage', () => {
  const f = fixture('focus unavailable');
  try {
    const result = invoke(f, ['--platform', 'android', '--udid', 'fake-device', '--stage', 'first-chat', '--label', 'Send', '--type', 'hello']);
    assert.equal(result.status, 1);
    assert.equal(existsSync(f.actions), false);
    const runDir = join(f.evidence, readdirSync(f.evidence)[0]);
    const checklist = JSON.parse(readFileSync(join(runDir, 'checklist.json'), 'utf8'));
    assert.equal(checklist.stages.find((item) => item.name === 'first-chat').status, 'failed-or-blocked');
  } finally {
    f.cleanup();
  }
});

test('iOS typing without an accessibility label fails before starting Appium', () => {
  const f = fixture();
  try {
    const result = invoke(f, ['--platform', 'ios', '--udid', 'fake-device', '--type', 'text']);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /--label LABEL/);
  } finally {
    f.cleanup();
  }
});

test('iOS checks expected text after the actual accessibility action', async () => {
  const f = fixture();
  const appium = await startMockAppium(f.dir);
  try {
    const pass = await invokeAsync(f, ['--platform', 'ios', '--udid', 'fake-device', '--stage', 'first-chat', '--appium-url', appium.url, '--label', 'Message input', '--type', 'hello', '--expect', 'after-text']);
    assert.equal(pass.status, 0, pass.stderr);
    const passDir = join(f.evidence, readdirSync(f.evidence)[0]);
    assert.equal(JSON.parse(readFileSync(join(passDir, 'result.json'), 'utf8')).expectedMatched, true);

    const beforeFail = new Set(readdirSync(f.evidence));
    const fail = await invokeAsync(f, ['--platform', 'ios', '--udid', 'fake-device', '--stage', 'first-chat', '--appium-url', appium.url, '--label', 'Message input', '--type', 'hello', '--expect', 'missing-after-text']);
    assert.equal(fail.status, 1);
    const failDir = join(f.evidence, readdirSync(f.evidence).find((name) => !beforeFail.has(name)));
    const checklist = JSON.parse(readFileSync(join(failDir, 'checklist.json'), 'utf8'));
    assert.equal(checklist.stages.find((item) => item.name === 'first-chat').status, 'failed-or-blocked');
  } finally {
    appium.child.kill('SIGTERM');
    f.cleanup();
  }
});

