import { debug } from '../debug/log.js';

export interface NonGitInitOptions {
  target: string;
  interactive: boolean;
  assumeYes: boolean;
  ask: (prompt: string) => Promise<string | undefined>;
}

/** Explicitly authorize creating a local Git repository and its initial commit. */
export async function decideNonGitInit({ target, interactive, assumeYes, ask }: NonGitInitOptions): Promise<'init' | 'refused' | 'non-interactive-refused'> {
  let decision: 'init' | 'refused' | 'non-interactive-refused';
  if (assumeYes) {
    decision = 'init';
  } else if (!interactive) {
    decision = 'non-interactive-refused';
  } else {
    const answer = await ask(`${target} 는 git 저장소가 아닙니다. 여기서 \`git init\` 하고 첫 커밋을 만들까요? 되돌리려면 \`.git\` 을 지우면 됩니다. [y/N] `);
    decision = /^(?:y|yes)$/i.test(answer?.trim() ?? '') ? 'init' : 'refused';
  }
  debug.log('harness.non-git', 'decided', { target, decision, interactive });
  return decision;
}
