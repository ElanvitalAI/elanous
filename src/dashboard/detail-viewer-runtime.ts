export interface DashboardDetailViewerSnapshot {
  title: string;
  lines: string[];
}

export interface DashboardDetailViewerRuntimeDeps {
  setOpen: (open: boolean) => void;
  requestRender: () => void;
  /** 그리기 «전에» 현재 내용을 위젯에 싣는다 — 채팅 단독 화면은 그리드 투영이 안 돌아 팝업이 비었다. */
  project?: (snapshot: DashboardDetailViewerSnapshot) => void;
}

export interface DashboardDetailViewerRuntime {
  snapshot(): DashboardDetailViewerSnapshot;
  set(title: string, lines: string[]): void;
  /** 내용만 바꾸고 팝업은 열지 않는다 — `/detail open` 으로 볼 원문(실패 지문 원문 등). */
  stage(title: string, lines: string[]): void;
  clear(): void;
  close(): void;
}

export function createDashboardDetailViewerRuntime(
  deps: DashboardDetailViewerRuntimeDeps,
): DashboardDetailViewerRuntime {
  let title = '';
  let lines: string[] = [];
  const render = (): void => {
    deps.project?.({ title, lines: [...lines] });
    deps.requestRender();
  };

  return {
    snapshot: () => ({ title, lines: [...lines] }),
    set(nextTitle, nextLines) {
      title = nextTitle;
      lines = [...nextLines];
      deps.setOpen(true);
      render();
    },
    stage(nextTitle, nextLines) {
      title = nextTitle;
      lines = [...nextLines];
      render();
    },
    clear() {
      title = '';
      lines = [];
      render();
    },
    close() {
      deps.setOpen(false);
    },
  };
}
