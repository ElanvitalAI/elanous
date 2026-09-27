// Terminal dimensions for the retained scratch-image viewer.
export function scratchImageSize(
  terminalRows: number,
  terminalCols: number,
): { rows: number; cols: number } {
  return {
    cols: Math.max(20, Math.min(60, Math.floor(terminalCols * 0.25))),
    rows: Math.max(8, Math.min(28, Math.floor(terminalRows * 0.45))),
  };
}
