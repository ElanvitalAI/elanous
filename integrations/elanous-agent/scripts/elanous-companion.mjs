#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

const project = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const store = join(process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.cache/elanous-companion'), 'state', createHash('sha256').update(project).digest('hex').slice(0, 12));
const binary = process.env.ELANOUS_BIN || 'elanous';
const args = process.argv.slice(2);
const jobIdPattern = /^job-[0-9]+-[a-f0-9]+$/;
const sessionIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
// A job belongs to a Claude session only when that session is known for this call —
// never guessed from shared state (another session's SessionEnd would sweep it).
function callerSession() {
  const id = process.env.ELANOUS_COMPANION_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || '';
  return sessionIdPattern.test(id) ? id : null;
}

function ensureStore() { mkdirSync(store, { recursive: true }); }
function read(name) {
  try { return JSON.parse(readFileSync(join(store, name), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function write(name, value) {
  ensureStore();
  const tmp = join(store, `.${process.pid}-${randomBytes(6).toString('hex')}`);
  writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 });
  renameSync(tmp, join(store, name));
}
function jobFile(id) {
  if (!jobIdPattern.test(id)) throw new Error(`Invalid job id: ${id}`);
  return `${id}.json`;
}
function lastJob(id) {
  if (id) return id;
  const last = read('last-job.json');
  if (!last?.id) throw new Error('No previous job in this workspace');
  return last.id;
}
function currentJob(id) {
  const name = jobFile(lastJob(id));
  const job = read(name);
  if (!job) throw new Error(`Job not found: ${name.slice(0, -5)}`);
  return job;
}
function signal(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  // Orphaned Unix children can remain as zombies until init reaps them.
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  if (ps.status === 0 && ps.stdout.trim().startsWith('Z')) return false;
  return true;
}
function refresh(job) {
  if (job.status === 'running' && !signal(job.pid)) {
    // The worker can have finished writing before it exits; never overwrite its result.
    const latest = read(jobFile(job.id));
    if (latest?.status !== 'running') return latest;
    job = { ...job, status: 'failed', error: 'Background worker exited without a result', finishedAt: new Date().toISOString() };
    write(jobFile(job.id), job);
  }
  return job;
}
function agentArgs(text, opts) {
  const a = ['--tool-cwd', project, 'agent', '--json'];
  if (opts.fresh) a.push('--new');
  else if (opts.resume) {
    const session = read('last-session.json')?.sessionId;
    if (!session) throw new Error('No previous session in this workspace');
    a.push('--session', session);
  }
  a.push(text);
  return a;
}
function decodeAgent(output) {
  const value = JSON.parse(output.trim());
  if (typeof value.sessionId !== 'string' || typeof value.reply !== 'string') throw new Error('Invalid elanous agent response');
  write('last-session.json', { sessionId: value.sessionId });
  return value;
}
function parseTask(rest, stdinText) {
  const opts = { background: false, resume: false, fresh: false, json: false, stdin: false };
  const text = [];
  let parsing = true;
  for (const part of rest) {
    if (parsing && part === '--') { parsing = false; continue; }
    if (parsing && part === '--background') opts.background = true;
    else if (parsing && part === '--resume-last') opts.resume = true;
    else if (parsing && part === '--fresh') opts.fresh = true;
    else if (parsing && part === '--json') opts.json = true;
    else if (parsing && part === '--stdin') opts.stdin = true;
    else if (parsing && part.startsWith('--')) throw new Error(`Unknown option: ${part}`);
    else { parsing = false; text.push(part); }
  }
  if (opts.resume && opts.fresh) throw new Error('--resume-last and --fresh are mutually exclusive');
  // --stdin: the request arrives as data on standard input, never through shell words.
  if (opts.stdin) {
    if (text.length) throw new Error('--stdin takes the request from standard input only');
    const body = (stdinText ?? '').trim();
    if (!body) throw new Error('task requires text');
    return { opts, text: body };
  }
  if (!text.length || !text.join(' ').trim()) throw new Error('task requires text');
  return { opts, text: text.join(' ') };
}
function runAgent(a) {
  const invoke = argv => new Promise((ok, fail) => {
    const child = spawn(binary, argv, { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', code => code === 0 ? ok(stdout) : fail(new Error(stderr.trim() || `elanous exited ${code}`)));
  });
  return invoke(a).catch(error => {
    // Older agent CLIs have no --tool-cwd option. Their tools use process.cwd(),
    // already pinned to project above; only retry on that exact parser rejection.
    if (/^error: unknown option ['"]--tool-cwd['"]/i.test(error.message) && a[0] === '--tool-cwd' && a[1] === project) return invoke(a.slice(2));
    throw error;
  });
}
async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
async function task(rest) {
  const { opts, text } = parseTask(rest, rest.includes('--stdin') ? await readStdin() : undefined);
  const a = agentArgs(text, opts);
  if (!opts.background) {
    const result = decodeAgent(await runAgent(a));
    console.log(opts.json ? JSON.stringify(result) : result.reply);
    return;
  }
  const id = `job-${Date.now()}-${randomBytes(6).toString('hex')}`;
  const session = callerSession();
  const child = spawn(process.execPath, [process.argv[1], '_run', id, JSON.stringify(a)], {
    detached: true, stdio: 'ignore', cwd: project, env: process.env,
  });
  child.unref();
  write(jobFile(id), { id, status: 'running', pid: child.pid, startedAt: new Date().toISOString(), session });
  write('last-job.json', { id });
  console.log(opts.json ? JSON.stringify({ id }) : id);
}
async function worker(id, raw) {
  const name = jobFile(id);
  for (let attempt = 0; !read(name) && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (!read(name)) throw new Error('Background job record was not created');
  try {
    const output = await runAgent(JSON.parse(raw));
    const job = read(name);
    if (job?.status === 'running') {
      const result = decodeAgent(output);
      write(name, { ...job, status: 'done', result, finishedAt: new Date().toISOString() });
    }
  } catch (error) {
    const job = read(name);
    if (job?.status === 'running') write(name, { ...job, status: 'failed', error: error.message, finishedAt: new Date().toISOString() });
  }
}
// No job yet is a normal state, not an error — say so and exit 0.
function noJobsYet(id, json) {
  if (id || read('last-job.json')?.id) return false;
  console.log(json ? JSON.stringify({ status: 'none' }) : 'No elanous background jobs in this workspace yet.');
  return true;
}
function status(id, json) {
  if (noJobsYet(id, json)) return;
  const job = refresh(currentJob(id));
  console.log(json ? JSON.stringify(job) : `${job.id}: ${job.status}`);
}
function result(id, json) {
  if (noJobsYet(id, json)) return;
  const job = refresh(currentJob(id));
  if (job.status === 'failed') throw new Error(job.error);
  if (job.status !== 'done') { console.log(json ? JSON.stringify(job) : `${job.id}: ${job.status}`); return; }
  console.log(json ? JSON.stringify(job.result) : job.result.reply);
}
function cancel(id) {
  const job = refresh(currentJob(id));
  if (job.status === 'running') {
    // The worker is a process-group leader; killing its group also stops the agent child.
    try { process.kill(-job.pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    write(jobFile(job.id), { ...job, status: 'cancelled', finishedAt: new Date().toISOString() });
  }
  console.log(`${job.id}: ${read(jobFile(job.id)).status}`);
}
async function approve(taskId) {
  if (!taskId || !/^task:[0-9a-f]{12}$/.test(taskId)) throw new Error('approve requires a task id like task:0123456789ab');
  const location = spawnSync(binary, ['where', '--json'], { encoding: 'utf8' });
  if (location.error) throw location.error;
  if (location.status !== 0) throw new Error(location.stderr.trim() || 'elanous where failed');
  const { root, configDir } = JSON.parse(location.stdout);
  const token = readFileSync(join(configDir, 'acp-token'), 'utf8').trim();
  const { httpPort } = JSON.parse(readFileSync(join(root, 'nexus', 'runtime.json'), 'utf8'));
  if (!token || !Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) throw new Error('Invalid daemon location or token');
  const response = await fetch(`http://127.0.0.1:${httpPort}/v1/tasks/${encodeURIComponent(taskId)}/approve`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Approval failed (${response.status}): ${body}`);
  console.log(body.trim().replace(/\s+/g, ' ') || `Approved ${taskId}`);
}
async function hook(which) {
  ensureStore();
  let payload = {};
  try {
    if (!process.stdin.isTTY) {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    }
  } catch { /* Hooks remain silent on missing or malformed input. */ }
  const raw = payload.session_id || process.env.CLAUDE_CODE_SESSION_ID || '';
  const id = sessionIdPattern.test(raw) ? raw : null;
  if (which === 'session-start') {
    // Hand the session id to this session's later Bash calls (Claude Code sources CLAUDE_ENV_FILE).
    if (id && process.env.CLAUDE_ENV_FILE) appendFileSync(process.env.CLAUDE_ENV_FILE, `export ELANOUS_COMPANION_SESSION_ID=${id}\n`);
  } else if (which === 'session-end') {
    const owner = id;
    if (owner) {
      for (const file of readdirSync(store)) {
        if (!jobIdPattern.test(file.slice(0, -5)) || !file.endsWith('.json')) continue;
        const job = read(file);
        if (job?.session !== owner) continue;
        if (refresh(job).status !== 'running') {
          unlinkSync(join(store, file));
          if (read('last-job.json')?.id === job.id) unlinkSync(join(store, 'last-job.json'));
        }
      }
    }
  } else throw new Error(`Unknown hook: ${which}`);
}

async function main() {
  const [command, ...rest] = args;
  if (command === 'task') return task(rest);
  if (command === '_run') return worker(rest[0], rest[1]);
  if (command === 'hook') return hook(rest[0]);
  if (command === 'approve') return approve(rest[0]);
  if (['status', 'result', 'cancel'].includes(command)) {
    const json = rest.includes('--json');
    const ids = rest.filter(arg => arg !== '--json');
    if (ids.length > 1 || (command === 'cancel' && json)) throw new Error(`Invalid ${command} arguments`);
    if (command === 'status') return status(ids[0], json);
    if (command === 'result') return result(ids[0], json);
    return cancel(ids[0]);
  }
  throw new Error('Usage: elanous-companion.mjs task|status|result|cancel|approve|hook');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
