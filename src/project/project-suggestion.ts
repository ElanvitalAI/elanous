// 작업 폴더 → 프로젝트 제안을 «폴더가 바뀔 때마다» 다시 계산한다(IA1 리뷰 must-fix · 시작 시 process.cwd() 한 번만 보던 것).
// 같은 프로젝트를 연달아 다시 알리지 않는다 — 바뀐 경우에만 돌려준다.
import type { Project } from './project-store.js';

export function createProjectSuggester(suggest: (folder: string) => Project | null): (folder: string) => Project | null {
  let lastId: string | null = null;
  return (folder) => {
    let project: Project | null;
    try { project = suggest(folder); }
    catch { return null; } // 제안은 대화를 끊지 않는다
    const id = project?.id ?? null;
    if (id === lastId) return null;
    lastId = id;
    return project;
  };
}
