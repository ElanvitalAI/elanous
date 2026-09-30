const LONE_JAMO = /[\u3131-\u318e\u1100-\u11ff]/u;
const HANGUL_SYLLABLE = /[\uac00-\ud7a3]/u;

export function summarizeSubmitText(text: string): {
  chars: number;
  lines: number;
  lastIsLoneJamo: boolean;
  loneJamoCount: number;
  hasHangul: boolean;
} {
  const characters = [...text];
  const loneJamoCount = characters.filter(char => LONE_JAMO.test(char)).length;
  return {
    chars: characters.length,
    lines: text.split('\n').length,
    lastIsLoneJamo: LONE_JAMO.test(characters.at(-1) ?? ''),
    loneJamoCount,
    hasHangul: loneJamoCount > 0 || HANGUL_SYLLABLE.test(text),
  };
}

export function classifyLeftoverInput(
  input: string,
  msSinceSubmit: number,
): 'syllable' | 'jamo' | null {
  if (msSinceSubmit < 0 || msSinceSubmit > 1000 || [...input].length !== 1) return null;
  if (HANGUL_SYLLABLE.test(input)) return 'syllable';
  if (LONE_JAMO.test(input)) return 'jamo';
  return null;
}
