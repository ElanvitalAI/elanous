// TUI-only callback shared by the dashboard and self-implement runtime.
// Kept independent so loading the dashboard does not load the self-implement graph.
export type SoftStopSpaceObserver = ((toolCallId: string, spaceId: string) => void) | null;
let observer: SoftStopSpaceObserver = null;
export function setSelfImplementSoftStopSpaceObserver(value: SoftStopSpaceObserver): void { observer = value; }
export function observeSelfImplementSoftStopSpace(toolCallId: string, spaceId: string): void { observer?.(toolCallId, spaceId); }
