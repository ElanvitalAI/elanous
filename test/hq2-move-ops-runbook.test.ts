import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const relativePath = 'docs/runbooks/RUNBOOK-hq2-move-ops-to-mac-mini-2026-10-03.md';
const doc = readFileSync(resolve(root, relativePath), 'utf8');
const sections = ['준비', '병행', '전환', '되돌리기·장애 훈련'];

describe('HQ2 운영 호스트 이전 런북', () => {
  test('mbp와 미니의 전체 cron·launchd를 실제 호스트에서 다시 재고 정본 목록과 대조한다', () => {
    const inventory = doc.split('## 0. 현장 재는 명령')[1]?.split('## 1. 준비')[0];
    expect(inventory).toBeTruthy();
    expect(inventory).toContain('mbp와 맥미니에서 각각');
    for (const command of ['crontab -l', 'sudo crontab -l', 'elanous schedule list --json',
      'launchctl print "gui/$(id -u)"', 'launchctl print system', '/Library/LaunchDaemons',
      'tailscale serve status']) {
      expect(inventory).toContain(command);
    }
    for (const responsibility of ['운영 데몬', '봇 넷', '알림·백업', '야간 설치본 갱신', '릴리스 루프', '자리 루프']) {
      expect(inventory).toContain(responsibility);
    }
    expect(inventory).toContain('dscl /Search -list /Users UniqueID');
    expect(inventory).toContain('launchctl print gui/<uid>');
    expect(inventory).toContain('launchctl print-disabled gui/<uid>');
    expect(inventory).toContain('sudo ls -la /var/at/tabs');
    expect(inventory).toContain('sudo ls -la /usr/lib/cron/tabs');
    expect(inventory).toContain("sudo crontab -u '<계정명>' -l");
    expect(inventory).toContain('계정 열거 실패');
    expect(inventory).toContain('접근 거부');
    expect(inventory).toContain('미측정');
    expect(inventory).toContain('교집합/차집합');
  });

  test('순서별로 재는 명령과 실행 가능한 되돌리기를 함께 둔다', () => {
    for (const [index, name] of sections.entries()) {
      const part = doc.split(`## ${index + 1}. ${name}`)[1]?.split(`## ${index + 2}.`)[0];
      expect(part).toBeTruthy();
      expect(part).toMatch(/\*\*재는 명령:\*\*.*(?:crontab -l|launchctl print)/s);
      expect(part).toMatch(/\*\*되돌리기:\*\*.*(?:bootout|disable|그대로 둔다)/s);
    }
    expect(doc).toContain('mbp 재부팅에도 무중단');
    expect(doc).toContain('미니 전원 차단 뒤 무인 복귀');
    expect(doc).toContain('sysctl -n kern.boottime');
    expect(doc).toContain('정전 구간 무중단은 불가능');
    expect(doc).toContain('중복 송신 창 0');
  });

  test('mbp launchd의 영속 정지와 재부팅 확인 및 되돌리기 재활성화를 명시한다', () => {
    const cutover = doc.split('## 3. 전환')[1]?.split('## 4.')[0];
    const recovery = doc.split('## 4. 되돌리기·장애 훈련')[1]?.split('## 5.')[0];
    expect(cutover).toContain('launchctl disable <mbp-도메인>/<mbp-label>');
    expect(cutover).toContain('launchctl bootout <mbp-도메인>/<mbp-label>');
    expect(cutover).toContain('launchctl print-disabled <mbp-도메인>');
    expect(cutover).toContain('launchctl enable <mbp-도메인>/<mbp-label>');
    expect(cutover).toContain('launchctl bootstrap <mbp-도메인> <보존한-mbp-plist>');
    expect(recovery).toContain('mbp 재부팅 뒤 `launchctl print-disabled <mbp-도메인>`');
    expect(recovery).toContain('launchctl enable <mbp-도메인>/<mbp-label>');
  });

  test('등록부 밖 다른 계정 및 /etc cron의 전환·영속 차단·복귀를 한 책임에 연결한다', () => {
    const inventory = doc.split('## 0. 현장 재는 명령')[1]?.split('## 1. 준비')[0] ?? '';
    const cutover = doc.split('## 3. 전환')[1]?.split('## 4.')[0] ?? '';
    const recovery = doc.split('## 4. 되돌리기·장애 훈련')[1]?.split('## 5.')[0] ?? '';
    expect(inventory).toContain('등록부 ID(있으면)');
    expect(inventory).toContain('sudo crontab -u \'<계정명>\' -e');
    expect(inventory).toContain('sudoedit <실제-원천-파일>');
    expect(inventory).toContain('sudo mv <보관소>/<원래-이름> <실제-원천-파일>');
    expect(cutover).toContain('sudo crontab -u \'<mini-계정명>\' -e');
    expect(cutover).toContain('mbp 재부팅 후 **같은 계정별·/etc·periodic 조회**');
    expect(cutover).toContain('비등록 잡은 mbp 원천 계정');
    expect(recovery).toContain('비등록 사용자·`/etc`·periodic은 §3의 대상별 복귀 명령');
    expect(recovery).toContain('OFF를 확인한 후에만 mbp에서');
    expect(recovery).toContain('sudo crontab -u \'<계정명>\' -e');
  });

  test('미니 launchd는 disable 해제 후 기동하고 두 상태를 확인한다', () => {
    const cutover = doc.split('## 3. 전환')[1]?.split('## 4.')[0] ?? '';
    const enable = cutover.indexOf('launchctl enable <mini-도메인>/<mini-label>');
    const bootstrap = cutover.indexOf('launchctl bootstrap <mini-도메인> <mini-plist>');
    expect(enable).toBeGreaterThan(-1);
    expect(bootstrap).toBeGreaterThan(enable);
    expect(cutover).toContain('launchctl print-disabled <mini-도메인>');
    expect(cutover).toContain('launchctl print <mini-도메인>/<mini-label>');
  });

  test('미니 접속 불가 복귀는 물리 격리 확인 전 mbp 발신 재활성화를 거부한다', () => {
    const recovery = doc.split('## 4. 되돌리기·장애 훈련')[1]?.split('## 5.')[0] ?? '';
    expect(recovery).toContain('<전원-제어기> off <mini-콘센트>');
    expect(recovery).toContain('<전원-제어기> status <mini-콘센트>');
    expect(recovery).toContain('OFF를 확인하지 못하면 mbp 발신·cron·데몬을 재활성화하지 않고');
    expect(recovery).toContain('네트워크를 물리 분리한 격리 부팅');
    expect(recovery).toContain('mini는 물리 OFF로 유지');
  });

  test('전환과 복귀에서 새 소유자 활성화 전에 기존 실행과 배송을 종결하거나 송신을 차단한다', () => {
    const inventory = doc.split('## 0. 현장 재는 명령')[1]?.split('## 1. 준비')[0] ?? '';
    const cutover = doc.split('## 3. 전환')[1]?.split('## 4.')[0] ?? '';
    const recovery = doc.split('## 4. 되돌리기·장애 훈련')[1]?.split('## 5.')[0] ?? '';
    expect(inventory).toContain('sudo ps -axo pid,ppid,user,stat,lstart,command');
    expect(inventory).toContain('진행 중인 실행·재시도·큐 배달도 0');
    const forward = cutover.split('- **활성화 전 실행 장벽:**')[1]?.split('- **되돌림 전 실행 장벽:**')[0] ?? '';
    expect(forward).toContain('mbp의 예약·launchd를 영속 차단한 **뒤**');
    expect(forward).toContain('mini는 **비활성 유지**');
    expect(forward).toContain('종료·배송 종결했거나 해당 책임의 모든 송신이 검증된 제어점에서 차단');
    expect(cutover).toContain('mbp의 비활성 상태와 위 **활성화 전 실행 장벽** 통과를 확인한 뒤 미니에 같은 책임을 단 한 번 활성화');
    const backward = cutover.split('- **되돌림 전 실행 장벽:**')[1]?.split('- **조치:**')[0] ?? '';
    expect(backward).toContain('mini의 예약·launchd를 영속 차단한 **뒤**');
    expect(backward).toContain('mbp는 비활성 유지');
    expect(backward).toContain('이미 시작한 작업과 재시도가 종결됐거나');
    expect(recovery).toContain('기존 실행·분리 워커·재시도');
    expect(recovery).toContain('OFF 확인 전에는 mbp cron·데몬·라우팅을 비활성으로 유지');
    expect(recovery).toContain('그 뒤 **§4 mbp 재활성화 전 실행 장벽 통과(작업 종결 또는 모든 송신 차단)를 확인하고** mbp에서');
    expect(cutover).toContain('위 되돌림 전 실행 장벽(기존 작업 종결 또는 모든 송신 차단)');
  });

  test('비밀 출처만 적고 현재 운영을 실측했다고 주장하지 않는다', () => {
    const secretSection = doc.split('## 5. 비밀의 **출처만** 확인')[1];
    expect(secretSection).toContain('Keychain');
    expect(secretSection).toContain('Secrets Manager');
    expect(secretSection).toContain('~/.elanous');
    expect(doc).toContain('아직 집행/실기기 검증 안 함');
    expect(doc).toContain('Release note (internal, English): Drafted');
    expect(readFileSync(resolve(root, 'docs/_index.md'), 'utf8')).toContain(`(runbooks/${relativePath.split('/').at(-1)})`);
  });
});
