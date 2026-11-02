import type { Command } from 'commander';

/** Shared option contract keeps the lightweight help shell and full PR action in sync. */
export function registerPrLandOptions(command: Command): void {
  command
    .description('현재 브랜치 PR을 생성 또는 갱신해 ready 상태로 만들고 squash merge')
    .option('--base <branch>', 'PR base branch')
    .option('--cwd <path>', '작업 트리 경로')
    .option('--pr <number>', '기존 PR 번호 고정 (--expected-head 와 함께)')
    .option('--expected-head <sha>', '리뷰된 PR 머리 SHA 고정 (--pr 와 함께)')
    .option(
      '--heavy-remote',
      '머리 고정 착지의 무거운 게이트를 node-b·node-c 중 빈 호스트에서 실행; head⊕main 증거가 없거나 실패하면 거부(로컬 폴백 없음)',
    )
    .option('--heavy-on-pod-shadow', '--heavy-remote 판정을 유지하고 같은 head/main의 Pod 타입·변경 시험 결과를 비교만 한다')
    .option('--dry-run', '변경 없이 landing 계획만 출력')
    .option('--hold', 'PR을 생성 또는 갱신한 뒤 병합하지 않고 쌓아 둔다')
    .option('--title <title>', 'PR title')
    .option('--title-file <path>', 'PR title file')
    .option('--body <body>', 'PR body')
    .option('--body-file <path>', 'PR body file')
    .option('--commit-message <message>', 'upsert commit message')
    .option('--commit-message-file <path>', 'upsert commit message file (takes precedence over --commit-message)')
    .option('--include-active-run-files', '도는 런 파일을 이번 착지에 포함 (기본 동작)')
    .option('--exclude-active-run-files', '도는 런과 겹친 파일을 이번 착지에서 제외')
    .option('--exclude-active-run-sources', '⚠ 위험: --exclude-active-run-files 가 골 문서가 아닌 파일(소스)을 빼도 착지를 강행')
    .option('--land-reason <text>', '권고를 보고도 지금 내는 이유(예: 남이 기다리는 차단 해제)')
    .option('--force-freeze <reason>', '동결을 넘겨 병합할 명시적 이유(필수)')
    .option('--allow-public-leak', '바뀐 파일이 공개본에 사적 흔적을 실어도 착지(이유는 --land-reason)')
    .option(
      '--overlap-evidence <file>',
      '머리 고정 착지 전용: 비대화형 겹침 승인을 대신할 증거 JSON {pr, head, gate:{head,baseCommit,passed}, reviewResult} — 재기반·재게이트·리뷰를 CLI 가 다시 잰다(겹친 착지가 전부 머리의 조상이면 리뷰만 · gate 생략 가능)',
    );
}
