export type DashboardCompanionSlashTarget = 'clipboard' | 'memo' | 'detail';

export interface DashboardCompanionSlashRuntimeDeps {
  muted: (text: string) => string;
  warning: (text: string) => string;
}

export interface DashboardCompanionSlashRuntime {
  openedLine(target: DashboardCompanionSlashTarget): string;
  closedLine(target: DashboardCompanionSlashTarget): string;
  toggledLine(target: DashboardCompanionSlashTarget, opened: boolean): string;
  usageLine(target: DashboardCompanionSlashTarget): string;
  detailClearedLine(): string;
}

const LABEL: Record<DashboardCompanionSlashTarget, string> = {
  clipboard: 'clipboard',
  memo: 'memo',
  detail: 'detail',
};

export function createDashboardCompanionSlashRuntime(
  deps: DashboardCompanionSlashRuntimeDeps,
): DashboardCompanionSlashRuntime {
  return {
    openedLine: (target) => deps.muted(`  ${LABEL[target]} companion popup opened`),
    closedLine: (target) => deps.muted(`  ${LABEL[target]} companion popup closed`),
    toggledLine: (target, opened) => deps.muted(`  ${LABEL[target]} companion popup ${opened ? 'opened' : 'closed'}`),
    usageLine: (target) => {
      if (target === 'clipboard') return deps.warning('  Usage: /clipboard open|close|toggle|clear');
      if (target === 'memo') return deps.warning('  Usage: /memo open|close|toggle|save');
      return deps.warning('  Usage: /detail open|close|toggle|clear');
    },
    detailClearedLine: () => deps.muted('  detail viewer cleared'),
  };
}
