import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

const [scratch, helper, started, finished, cliEntry] = process.env.ELANOUS_TASK_LAUNCH_FIXTURE.split('\n');
const childCode = "const fs = require('node:fs'); process.stderr.write('detached child done\\n'); fs.writeFileSync(process.argv[1], 'started'); setTimeout(() => { fs.writeFileSync(process.argv[2], 'finished'); process.exit(0); }, 500);";
const fd = openSync(`${scratch}/detached-child.stderr`, 'w');
const task = spawn(process.execPath, [helper, scratch, String(process.pid), process.execPath, '-e', childCode, started, finished], {
  detached: true,
  stdio: ['ignore', 'ignore', fd],
});
closeSync(fd);
task.unref();

await import(cliEntry);
