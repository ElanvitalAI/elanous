import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

// ── 리눅스 갈래(WORKER-WSL-LINUX-POOL) — 원격 실행은 PATH 앞의 가짜 ssh 가 받는다(명령을 기록만 · 실제 ssh 없음).
//    가짜 kubectl 은 늘 실패하고 HOME 은 임시 디렉토리라 이 맥의 ~/.kube/config 에 닿지 않는다.
type Rule = [pattern: string, rc: number, stdout?: string];

function runNodeSetup(opts: { os: 'Linux' | 'Darwin'; check: boolean; defaultRc: 0 | 1; rules?: Rule[] }) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-node-setup-'));
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  const calls = join(dir, 'calls');
  const rules: Rule[] = [['all_proxy; true', 0], ['uname -s', 0, opts.os], ...(opts.rules ?? [])];
  writeFileSync(join(dir, 'rules'), rules.map(([p, rc, out = '']) => `${p}\t${rc}\t${out}`).join('\n') + '\n');
  writeFileSync(join(bin, 'ssh'), `#!/bin/bash
cmd="\${@: -1}"
printf '%s\\n' "$cmd" >> "$FAKE_CALLS"
while IFS=$'\\t' read -r pat rc out; do
  [ -n "$pat" ] || continue
  case "$cmd" in *"$pat"*) [ -z "$out" ] || printf '%s\\n' "$out"; exit "$rc";; esac
done < "$FAKE_RULES"
exit "$FAKE_DEFAULT_RC"
`, { mode: 0o755 });
  writeFileSync(join(bin, 'kubectl'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
  try {
    const args = [resolve(import.meta.dir, 'node-setup.sh'), 'fixture-node', ...(opts.check ? ['--check'] : [])];
    const result = spawnSync('bash', args, {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        FAKE_CALLS: calls,
        FAKE_RULES: join(dir, 'rules'),
        FAKE_DEFAULT_RC: String(opts.defaultRc),
        ELANOUS_FLEET_CODEX_VERSION: '0.159.3',
        ELANOUS_FLEET_TSNAME: '',
      },
    });
    const invocations = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, invocations };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const anyCall = (invocations: string[], needle: string) => invocations.some((c) => c.includes(needle));

describe('fleet node setup — 원격 OS 갈래', () => {
  test('Linux --check: 리눅스 단계를 «할 일»로만 내고 brew·Chrome·zshenv·sudo 는 안 부른다', () => {
    const r = runNodeSetup({ os: 'Linux', check: true, defaultRc: 1 });
    for (const line of [
      '→ apt 기본 패키지',
      '→ docker-ce 설치(공식 apt 저장소',
      '→ systemctl enable --now docker containerd',
      '→ usermod -aG docker',
      '→ ~/.docker-fleet(빈 currentContext)',
      '→ k3d 설치(공식 install.sh)',
      '→ kubectl v1.36.4 설치(지금 없음 · sha256 검증)',
      '→ nodejs 설치',
      '→ codex CLI 0.159.3',
      'git init --bare -b main',
      '✋ 사람 손 할 일',
      'wsl.exe -d <배포판 이름>',
      'codexHome',
    ]) expect(r.stdout).toContain(line);
    for (const needle of ['command -v brew', 'brew install', 'Google Chrome', '.zshenv', 'sudo', 'apt-get install', 'git init']) expect(anyCall(r.invocations, needle), needle).toBe(false);
    expect(r.stdout).not.toContain('Chrome');
  });

  test('Linux 실행: apt·k3d·kubectl(sha256)·nodejs 를 sudo -n 으로 깔고 brew 는 안 부른다', () => {
    const r = runNodeSetup({ os: 'Linux', check: false, defaultRc: 1, rules: [['k3d registry create', 0], ['git init -q --bare -b main', 0]] });   // 레지스트리를 넘겨야 미러·클러스터 단계까지 간다
    for (const needle of [
      'sudo -n apt-get install -y -qq ca-certificates curl unzip git python3',
      'sudo -n apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin',
      'Signed-By: /etc/apt/keyrings/docker.asc',
      'sudo -n systemctl enable --now docker containerd',
      'sudo -n usermod -aG docker',
      'k3d-io/k3d/main/install.sh | sudo -n bash',
      'https://dl.k8s.io/release/v1.36.4/bin/linux/$a/kubectl.sha256',
      'sha256sum --check && sudo -n install',
      'sudo -n apt-get install -y -qq nodejs',
      'bun add -g @openai/codex@0.159.3',
      'git init -q --bare -b main ~/mirror/elanous-agent.git',
      'k3d registry create elanous-registry --port 127.0.0.1:5050',
      'k3d cluster create elanous-pool --image rancher/k3s:v1.36.4-k3s1 --no-lb --api-port 0.0.0.0:6550 --k3s-arg --tls-san=fixture-node@server:0 --registry-use k3d-elanous-registry:5050 --volume $HOME/mirror:/mirror-host:ro@server:0 --wait --timeout 300s',
    ]) expect(anyCall(r.invocations, needle), needle).toBe(true);
    for (const needle of ['command -v brew', 'brew install', 'Google Chrome', '.zshenv']) expect(anyCall(r.invocations, needle)).toBe(false);
    expect(r.invocations.filter((c) => /sudo (?!-n )/.test(c))).toEqual([]);
  });

  test('Linux --check: 다 돼 있으면 리눅스 단계는 전부 ✓ (멱등)', () => {
    const r = runNodeSetup({
      os: 'Linux', check: true, defaultRc: 0,
      rules: [
        ['kubectl version --client', 0, 'v1.36.4'],
        ['codex --version', 0, 'codex-cli 0.159.3'],
        ['symbolic-ref HEAD', 0, 'refs/heads/main'],
        ['bun --version', 0, Bun.version],
        ['docker port k3d-elanous-registry', 0, '127.0.0.1:5050'],
      ],
    });
    for (const line of ['✓ 기본 패키지', '✓ systemd (PID 1)', '✓ docker-ce (apt)', '✓ docker·containerd 서비스', '✓ docker 그룹', '✓ 플릿 docker 설정', '✓ k3d', '✓ kubectl v1.36.4', '✓ node', '✓ codex 0.159.3', `✓ bun ${Bun.version}`, '✓ 레지스트리 k3d-elanous-registry :5050 (루프백)', '✓ 호스트 git 미러 ~/mirror/elanous-agent.git (HEAD=main)', '✓ 클러스터 elanous-pool']) expect(r.stdout).toContain(line);
    const todos = r.stdout.split('\n').filter((l) => l.startsWith('  →'));
    expect(todos.filter((l) => !/kubeconfig|base\.yaml/.test(l))).toEqual([]);   // 남는 할 일은 가짜 kubectl 이 늘 실패하는 이 맥 쪽 단계뿐
  });

  test('Linux: Docker Desktop shim 이면 사유를 내고 멈춘다(docker-ce 를 깔지 않는다)', () => {
    const r = runNodeSetup({ os: 'Linux', check: false, defaultRc: 1, rules: [['docker-desktop*) echo shim', 0, 'shim'], ['for c in curl', 0], ['ps -p 1', 0]] });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Docker Desktop shim');
    expect(anyCall(r.invocations, 'docker-ce')).toBe(false);
    expect(anyCall(r.invocations, 'k3d')).toBe(false);
  });

  test('Darwin: 종전 맥 단계(brew·zshenv·Chrome·brew k3d)를 그대로 타고 리눅스 갈래는 안 탄다', () => {
    const r = runNodeSetup({ os: 'Darwin', check: true, defaultRc: 1 });
    for (const needle of ['command -v brew', 'command -v docker >/dev/null && command -v brew', 'test -d "/Applications/Google Chrome.app"', 'command -v k3d', 'test -d ~/mirror/elanous-agent.git']) expect(anyCall(r.invocations, needle)).toBe(true);
    for (const needle of ['apt-get', 'dpkg', 'systemctl', 'tailscale.exe', 'symbolic-ref']) expect(anyCall(r.invocations, needle)).toBe(false);
    for (const line of ['✗ brew 없음', '→ ~/.zshenv 에 PATH 블록', '→ Chrome 설치', '→ k3d 설치', '→ 호스트 git 미러 ~/mirror/elanous-agent.git 생성(git init --bare) ⊕ 이 맥에서 첫 push']) expect(r.stdout).toContain(line);
    expect(r.stdout).not.toContain('사람 손 할 일');
    expect(r.stdout).not.toContain('OS Linux');
  });
});
