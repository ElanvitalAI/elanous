import { describe, expect, test } from 'bun:test';
import { podResultMarkerRc, podResultMarkerShellLine, stripPodResultMarker } from './pod-result-marker-wait.js';
import { podResultMarker, splitPodResultMarker } from './pod-command-job.js';

describe('pod result marker wait (si-task parity)', () => {
  test('the shell line prints the runPodCommand marker format for this token', () => {
    expect(podResultMarkerShellLine('run-abc_1')).toBe(`printf '\\n%s rc=%s\\n' '${podResultMarker('run-abc_1')}' "$rc"`);
    expect(podResultMarkerShellLine("run'; rm -rf /")).toBeNull();
    expect(podResultMarkerShellLine('')).toBeNull();
  });

  test('one poll: this launch\'s marker gives its rc; failed reads, other launches and bare words give null', () => {
    expect(podResultMarkerRc({ status: 0, stdout: `\n${podResultMarker('run-a')} rc=0\n` }, 'run-a')).toBe(0);
    expect(podResultMarkerRc({ status: 0, stdout: `${podResultMarker('run-a')} rc=7\n` }, 'run-a')).toBe(7);
    expect(podResultMarkerRc({ status: 1, stdout: `${podResultMarker('run-a')} rc=0\n` }, 'run-a')).toBeNull();
    expect(podResultMarkerRc({ status: null, stdout: '' }, 'run-a')).toBeNull();
    expect(podResultMarkerRc({ status: 0, stdout: `${podResultMarker('run-b')} rc=0\n` }, 'run-a')).toBeNull();
    expect(podResultMarkerRc({ status: 0, stdout: '__ELANOUS_POD_DONE__ rc=0\n' }, 'run-a')).toBeNull();
    expect(podResultMarkerRc({ status: 0, stdout: `${podResultMarker('run-a')} rc=0\nmore output\n` }, 'run-a')).toBeNull();
  });

  test('strip leaves the child output bytes as they were before the marker', () => {
    const body = 'line\n{"stage":"pr-opened","ok":true}\n';
    expect(stripPodResultMarker(`${body}\n${podResultMarker('run-a')} rc=0\n`, 'run-a')).toBe(body);
    expect(stripPodResultMarker(body, 'run-a')).toBe(body);
    expect(stripPodResultMarker(`${body}\n${podResultMarker('run-a')} rc=0\n`, 'run-b')).toBe(splitPodResultMarker(`${body}\n${podResultMarker('run-a')} rc=0\n`, 'run-b').logs);
  });
});
