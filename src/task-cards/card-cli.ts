import type { Command } from 'commander';
import { join, resolve } from 'node:path';
import { scanWishFolder } from '../intake-plane/wish-folder.js';
import { LINEAR_WISH_KEY_MISSING, scanLinearWishes } from '../intake-plane/linear-wish.js';
import type { fetchLinearIssues } from '../connectors/linear.js';
import { CardStore, type TaskCard } from './card-store.js';

export interface CardCliDeps {
  createStore?: () => CardStore;
  write?: (text: string) => void;
  getApiKey?: () => Promise<string | undefined>;
  fetchIssues?: typeof fetchLinearIssues;
}

function formatCard(card: TaskCard): string {
  const lines = [
    `ID: ${card.id}`,
    `Goal: ${card.goalId}`,
    `Title: ${card.title}`,
    `Status: ${card.status}`,
    `Created: ${card.createdAt}`,
  ];
  for (const section of card.sections) {
    lines.push('', `${section.key} (${section.owner}, ${section.createdAt}):`, section.content);
  }
  return lines.join('\n') + '\n';
}

/** Register card inspection and Wish note import commands. */
export function registerCardCommand(program: Command, deps: CardCliDeps = {}): Command {
  const createStore = deps.createStore ?? (() => new CardStore());
  const write = deps.write ?? ((text: string) => { process.stdout.write(text); });
  const card = program.command('card').description('Inspect task cards');

  card.command('show <id>')
    .description('Show a task card and its sections')
    .option('--json', 'Output JSON')
    .action((id: string, options: { json?: boolean }) => {
      const store = createStore();
      try {
        const result = store.getCard(id);
        if (!result) throw new Error(`Card not found: ${id}`);
        write(options.json ? `${JSON.stringify(result)}\n` : formatCard(result));
      } finally {
        store.close();
      }
    });

  card.command('list')
    .description('List task cards')
    .option('--open', 'Only show open cards')
    .option('--json', 'Output JSON')
    .action((options: { open?: boolean; json?: boolean }) => {
      const store = createStore();
      try {
        const cards = store.listCards({ open: options.open });
        if (options.json) {
          write(`${JSON.stringify(cards)}\n`);
        } else {
          write(cards.length === 0
            ? 'No cards.\n'
            : cards.map((item) => `${item.id}\t${item.status}\t${item.title}\t${item.goalId}\n`).join(''));
        }
      } finally {
        store.close();
      }
    });

  card.command('wish-scan')
    .description('Create task cards from Obsidian Wish notes')
    .option('--dir <path>', 'Wish folder path')
    .option('--json', 'Output JSON')
    .action((options: { dir?: string; json?: boolean }) => {
      const dir = resolve(options.dir ?? join(process.env.OBSIDIAN_VAULT_ROOT ?? '', '00. Inbox', '00. Wish'));
      let store: CardStore | undefined;
      try {
        const result = scanWishFolder({ dir, store: (store = createStore()) });
        write(options.json ? `${JSON.stringify(result)}\n` : `추가 ${result.added} · 갱신 ${result.updated} · 건너뜀 ${result.skipped}\n`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Wish 폴더를 찾지 못했습니다: ')) {
          process.stderr.write(`${error.message}\n`);
          process.exitCode = 2;
          return;
        }
        throw error;
      } finally {
        store?.close();
      }
    });

  card.command('intake-scan')
    .description('Scan Wish notes then Linear wishes in one scheduled invocation')
    .option('--dir <path>', 'Wish folder path')
    .option('--team <key>', 'Linear team key (omit to skip Linear)')
    .option('--label <name>', 'Wish label or title prefix', 'wish')
    .option('--json', 'Output JSON')
    .action(async (options: { dir?: string; team?: string; label: string; json?: boolean }) => {
      const result = {
        folder: { added: 0, updated: 0, skipped: 0 },
        linear: { added: 0, duplicate: 0, failed: 0 },
        skipped: [] as string[],
        failed: [] as string[],
      };
      let store: CardStore | undefined;
      try {
        const dir = resolve(options.dir ?? join(process.env.OBSIDIAN_VAULT_ROOT ?? '', '00. Inbox', '00. Wish'));
        store = createStore();
        result.folder = scanWishFolder({ dir, store });
      } catch {
        result.failed.push('Wish 폴더 스캔 실패');
      } finally {
        try { store?.close(); } catch {
          if (!result.failed.includes('Wish 폴더 스캔 실패')) result.failed.push('Wish 폴더 스캔 실패');
        }
      }

      store = undefined;
      if (!options.team?.trim()) {
        result.skipped.push('Linear 팀 미지정');
      } else {
        try {
          store = createStore();
          result.linear = await scanLinearWishes({ teamKey: options.team, label: options.label, store,
            deps: { getApiKey: deps.getApiKey, fetchIssues: deps.fetchIssues } });
          if (result.linear.failed > 0) result.failed.push(`Linear 항목 ${result.linear.failed}건 실패`);
        } catch (error) {
          if (error instanceof Error && error.message === LINEAR_WISH_KEY_MISSING) {
            result.skipped.push('Linear 키 없음');
          } else {
            result.failed.push('Linear 스캔 실패');
          }
        } finally {
          try { store?.close(); } catch {
            if (!result.failed.includes('Linear 스캔 실패')) result.failed.push('Linear 스캔 실패');
          }
        }
      }

      write(options.json ? `${JSON.stringify(result)}\n` :
        `폴더 추가 ${result.folder.added} · Linear 추가 ${result.linear.added} · 건너뜀(${result.skipped.join(', ') || '없음'})${result.failed.length ? ` · 실패(${result.failed.join(', ')})` : ''}\n`);
      if (result.failed.length) process.exitCode = 1;
    });

  card.command('linear-scan')
    .description('Create wish cards from open Linear issues')
    .requiredOption('--team <key>', 'Linear team key')
    .option('--label <name>', 'Wish label or title prefix', 'wish')
    .option('--json', 'Output JSON')
    .action(async (options: { team: string; label: string; json?: boolean }) => {
      let store: CardStore | undefined;
      try {
        store = createStore();
        const result = await scanLinearWishes({ teamKey: options.team, label: options.label, store,
          deps: { getApiKey: deps.getApiKey, fetchIssues: deps.fetchIssues } });
        write(options.json ? `${JSON.stringify(result)}\n` : `추가 ${result.added} · 중복 ${result.duplicate} · 실패 ${result.failed}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message.split(/\r?\n/, 1)[0]}\n`);
        process.exitCode = message === LINEAR_WISH_KEY_MISSING ? 2 : 1;
      } finally {
        store?.close();
      }
    });

  return card;
}
