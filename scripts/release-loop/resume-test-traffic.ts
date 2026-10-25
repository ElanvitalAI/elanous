// Resume tests need the same writable traffic-file prerequisite as the installed release configuration.
// This module is imported only by test files; the gate process owns and discards this environment.
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const trafficFile = join(tmpdir(), `elanous-resume-test-traffic-${process.pid}.json`);
writeFileSync(trafficFile, '{}\n');
process.env.ELANOUS_RELEASE_TRAFFIC_FILE = trafficFile;
process.once('exit', () => rmSync(trafficFile, { force: true }));
