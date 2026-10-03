import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = readFileSync(resolve(import.meta.dir, 'node-setup.sh'), 'utf8');
const dns = source.slice(source.indexOf('DNS_READY="'), source.indexOf('\nv="$(kubectl', source.indexOf('DNS_READY="')));

test('node setup check requires both coredns Ready and one successful Pod DNS answer', () => {
  expect(dns).toContain('DNS_READY=');
  for (const [ready, answer, ok] of [
    ['1/1', 'Name: kubernetes.default.svc.cluster.local\nAddress: 10.43.0.1', true],
    ['0/1', 'Name: kubernetes.default.svc.cluster.local\nAddress: 10.43.0.1', false],
    ['1/1', 'Name: another.service\nAddress: 10.43.0.1', false],
  ] as const) {
    const wrapper = `CTX=pool-node-c; FAIL=0
ok() { printf 'ok %s\\n' "$1"; }
bad() { printf 'bad %s\\n' "$1"; FAIL=1; }
kubectl() {
  case " $* " in
    *' get deployment coredns '*) printf '%s\\n' "$READY" ;;
    *' create -f - '*) cat >/dev/null ;;
    *' wait --for=jsonpath='*) : ;;
    *' get pod/'*) printf '%s\\n' "Succeeded:" ;;
    *' logs pod/'*) printf '%s\\n' "$ANSWER" ;;
    *' delete pod/'*) : ;;
    *) return 1 ;;
  esac
}
${dns}
printf 'dns-check-rc=%s\\n' "$FAIL"`;
    const result = spawnSync('bash', ['-c', wrapper], { encoding: 'utf8', env: { ...process.env, READY: ready, ANSWER: answer } });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`dns-check-rc=${ok ? 0 : 1}`);
    expect(result.stdout).toContain(ok ? 'ok dns' : 'bad dns');
  }
});

test('node setup distinguishes image pull failure from DNS lookup failure', () => {
  const wrapper = `CTX=pool-node-c; FAIL=0
ok() { printf 'ok %s\\n' "$1"; }
bad() { printf 'bad %s\\n' "$1"; FAIL=1; }
kubectl() {
  case " $* " in
    *' get deployment coredns '*) printf '1/1\\n' ;;
    *' create -f - '*) cat >/dev/null ;;
    *' wait --for=jsonpath='*) return 1 ;;
    *' get pod/'*) printf 'Pending:ImagePullBackOff\\n' ;;
    *' logs pod/'*) return 1 ;;
    *' delete pod/'*) : ;;
    *) return 1 ;;
  esac
}
${dns}
printf 'dns-check-rc=%s\\n' "$FAIL"`;
  const result = spawnSync('bash', ['-c', wrapper], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('bad dns 점검 이미지 확보 실패 (DNS 미측정)');
  expect(result.stdout).not.toContain('bad dns (Pod 이름 풀이 실패)');
  expect(result.stdout).toContain('dns-check-rc=1');
});
