# src/tui/ — elanous 로컬 TUI 서피스 (표현 전용)

> RFC: [`내부 문서 `RFC-elanous-tiered-tool-exposure-2026-07-17``](../../내부 문서 `RFC-elanous-tiered-tool-exposure-2026-07-17`) §6b.
> 이 디렉토리는 **TUI 서피스의 순수 화면 표현**만 담는다. TUI 는 멀티서피스
> (telegram·discord·PWA·voice·mission) 중 **하나**일 뿐 — 크로스서피스 core
> 장치(턴 루프·tool 노출·shell/PTY 실행·HITL·세션)는 여기 두지 않는다.

## 판별 원칙
> "이 장치가 **TUI 말고도 서피스가 쓰나?** → 중립 home(core-turn·session-runtime·
> shell-runner·hitl·surface). **순수 화면 표현인가?** → `tui/`."

## 목표 구조
```
src/tui/
  render/            # 텍스트 렌더 core (essential 상시)
  chat/              # 채팅 프레젠테이션 (essential)   ← execution-badge (M2 착수)
  input/             # 키보드/입력
  rich/              # ── opt-in · essential 비활성 ──
    panes/           #   VW 페인
    windowing/       #   virtual-windows 배치
    terminal/        #   터미널 매트릭스 표현
    modals/          #   모달·context-menu
```
- **essential 모드 = `tui/rich` 를 import 안 함** (번들·인지 경계 분리).
- `rich` 이전은 해당 파일의 **실행을 shell-runner 로 먼저 분리한 뒤**(PTY 우산 P1)
  순수 렌더만 옮긴다.

## 마이그레이션 (progressive shim · 배틀쉽식)
- 파일을 `dashboard/` → `tui/<layer>/` 로 이전 + 구경로 **re-export shim** 으로
  하위호환 → God-object(`dashboard/index.ts`) 무접촉.
- caller 이관 완료 시 shim 삭제. **God-object 는 최후.**
- M4: shim 전부 삭제 + "신규 `dashboard/` import 금지" 가드 → "dashboard" 명칭 소멸.

## 현황 (M2 착수)
- ✅ `tui/chat/execution-badge.ts` — 실행모델 뱃지 리졸버 (dashboard/ 에서 이전, shim 유지)
- ✅ `tui/entry.ts` · `tui/chat/log-view.ts` · `tui/input/composer.ts` — `elanous --tui next` 로 여는 로컬 대화 화면. 공용 inline editor 로 입력·전송하고 공용 REPL 턴 경로를 JSONL stdin 자식으로 호출한다. `--tui classic` 과 기본 진입은 기존 dashboard 를 사용한다.
- ✅ `tui/size-contract.test.ts` — 이 디렉토리 TypeScript 파일의 4,000줄 상한을 검사한다.
- ⬜ render · input · rich/* — 후속 슬라이스
