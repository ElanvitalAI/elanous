import { existsSync } from 'node:fs';

export function parseInjectArgs(
  argv: string[],
  env: { TELEGRAM_TEST_BOT?: string | undefined },
): { to: string; text?: string; photos: string[]; caption?: string } {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`옵션 값 없음: ${flag}`);
    return next;
  };
  const to = value('--to') ?? env.TELEGRAM_TEST_BOT;
  const text = value('--text');
  const photos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--photo') continue;
    const photo = argv[++i];
    if (!photo || photo.startsWith('--') || !existsSync(photo)) {
      throw new Error(`사진 파일 경로 없음: ${photo ?? '(미지정)'}`);
    }
    photos.push(photo);
  }
  if (!to || (!text && photos.length === 0)) {
    throw new Error('사용: telegram-inject.ts --to @monad_test_bot --text "<objective>"');
  }
  return photos.length > 0
    ? { to, photos, ...(text !== undefined ? { caption: text } : {}) }
    : { to, text, photos };
}
