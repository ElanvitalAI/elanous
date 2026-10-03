export type PhonePane = 'list' | 'canvas' | 'run';

export function isPhoneWidth(width: number): boolean {
  return width < 640;
}

export function phonePaneFor(requestedPane: PhonePane | null, selectedName: string | null): PhonePane {
  return requestedPane ?? (selectedName ? 'canvas' : 'list');
}
