import type { Command } from 'commander';
import { join, resolve } from 'node:path';
import { scanWishFolder } from '../intake-plane/wish-folder.js';
import { CardStore, type TaskCard } from './card-store.js';

export interface CardCliDeps {
  createStore?: () => CardStore;
  write?: (text: string) => void;
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

  return card;
}
