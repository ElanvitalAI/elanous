export interface ClassicSidetabMissionResult {
  ok: boolean;
  status?: 'running' | 'completed' | 'cancelled' | 'failed';
  path?: string;
  content?: string;
  error?: string;
  /** PTY process status when it exited before the result was finalized; null means signal/unknown. */
  exitCode?: number | null;
  interactionId?: string;
  /** Final raw child PTY screen, retained in the parent comparison recording. */
  finalScreen?: string;
  /** Child PTY exit status, if the session ended while the mission was observed. */
  exitObservation?: 'natural-exit' | 'cleanup-exit' | 'cleanup-unobserved';
  /** Whether the separate completion marker was observed after the result file. */
  completionMarker?: boolean;
  /** First child PTY frame, retained to explain startup menus and input interception. */
  initialScreen?: string;
  failureStage?: string;
  failureScreen?: string;
}
