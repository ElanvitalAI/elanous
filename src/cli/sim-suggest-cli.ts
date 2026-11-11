import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { getTestStateRoot } from '../nexus/paths.js';

/** Register the app scenario proposal path without loading the other simulation runners. */
export function registerSimSuggestCommand(sim: Command): void {
  sim.command('suggest <app-file> <request>')
    .description('app.yaml 장치 선언 안에서 자연어 시나리오를 제안한다(test 우주)')
    .action(async (appFile: string, request: string) => {
      try {
        if (!getTestStateRoot()) throw new Error('scenario suggestion requires --test isolated mode');
        const { parseAppManifest } = await import('../nexus/apps/app-contract.js');
        const { proposeNaturalLanguageScenario } = await import('../ux-sim/nl-scenario.js');
        const { resolveDefaultProviderAsync } = await import('../llm.js');
        const { testFakeLlmEnabled, testFakeLlmProvider } = await import('../ux-sim/fake-llm.js');
        const parsed = parseAppManifest(readFileSync(appFile, 'utf8'));
        if (!parsed.ok) throw new Error('invalid app contract');
        const provider = testFakeLlmEnabled() ? testFakeLlmProvider : await resolveDefaultProviderAsync();
        const result = await proposeNaturalLanguageScenario({ request, simulate: parsed.manifest.simulate,
          chooseEvent: async ({ request: question, allowedEvents }) => {
            if (!provider.available()) throw new Error('model unavailable');
            const prompt = `Choose exactly one event ID from the list for the user's scenario request. Reply with the event ID only.\nAllowed events: ${allowedEvents.join(', ')}\nRequest: ${question}`;
            let answer = '';
            for await (const chunk of provider.chat([{ role: 'user', content: prompt }])) answer += chunk;
            return answer.trim();
          } });
        console.log(JSON.stringify(result));
        if (result.status !== 'proposed') process.exitCode = 1;
      } catch (error) {
        console.error(`sim suggest: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });
}
