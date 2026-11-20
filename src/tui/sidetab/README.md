# src/tui/sidetab — eln TUI 사이드탭 (신규 기능 동결 · 대표 2026-11-18)

정본: 내부 문서 `SIDETAB-ONE-SPACE` (ELS-PRODUCT-SPLIT · POOL-QUEUE-1118 칸 2)

- 이 디렉터리는 eln TUI 의 사이드탭 UI 다. 대표 11-18 «분리해서 진행» 결정으로 **새 기능 모듈을 여기에 더하지 않는다.**
- 새 «액자» 기능(배치·탭 순서·마우스·attach·펼침·연합·사이드탭 그림 전반)은 els 공간(`src/els/` · els 프로세스)으로.
  사이드챗의 «두뇌»는 eln 코어 세션이 프로토콜로만 담당한다(칸 3 SIDE-ELN-BRAIN: import 0).
- 기존 모듈은 유지·수리(버그픽스·기존 동작 보존)만 한다.
- 예외: 칸 1 ELS-ONE-SPACE 교량(eln --side 가 els 클라이언트가 되는 `els-rows`·`els-subscribe`·
  `els-sidetab-pty` 계열) — 이 완료선을 닫는 변경만 허용.

동결 시점 스냅샷(2026-11-18 main): agent-state, agents-sidechat, attach, els-rows, els-subscribe,
full-transcript, herdr-portal, interaction, list, new-pty-picker, nl-tool, peek, remote, sections,
sidechat-session, workspace-broadcast, workspace-input-controller, workspace-input-ports,
workspace-terminal-writer (+ els-sidetab-pty 시험).
