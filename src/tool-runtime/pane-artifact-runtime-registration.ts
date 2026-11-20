import { registerArtifactRuntimes } from './artifact-runtimes.js';
import { registerPaneRuntimes } from './pane-runtimes.js';
import { registerPaneWatchCompareRuntimes } from './pane-watch-compare-runtimes.js';
import { registerRecordingRuntimes } from './recording-runtimes.js';
import type { ArtifactStore } from '../artifact/store.js';
import type { PaneVisualStateStore } from '../panes/visual-state.js';
import type { WidgetHost } from '../widgets/host.js';

export interface DashboardPaneArtifactRuntimeRegistrationDeps {
  artifactStore: ArtifactStore;
  widgetHost: WidgetHost;
  paneVisualStateStore: PaneVisualStateStore;
  registerArtifact?: typeof registerArtifactRuntimes;
  registerRecording?: typeof registerRecordingRuntimes;
  registerPane?: typeof registerPaneRuntimes;
  registerPaneWatchCompare?: typeof registerPaneWatchCompareRuntimes;
}

export function registerDashboardPaneArtifactRuntimes(
  deps: DashboardPaneArtifactRuntimeRegistrationDeps,
): void {
  (deps.registerArtifact ?? registerArtifactRuntimes)({ store: deps.artifactStore });
  (deps.registerRecording ?? registerRecordingRuntimes)({
    widgetHost: deps.widgetHost,
    artifactStore: deps.artifactStore,
  });
  (deps.registerPane ?? registerPaneRuntimes)({ store: deps.paneVisualStateStore });
  (deps.registerPaneWatchCompare ?? registerPaneWatchCompareRuntimes)({});
}
