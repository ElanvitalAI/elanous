import { AdaptiveGraphReplayView } from '@/components/live-run/AdaptiveGraphReplay';
import { graphDesignReplayFixture } from '@/test-devices/graph-design-replay';

export default function AdaptiveGraphPage() {
  return <AdaptiveGraphReplayView replay={graphDesignReplayFixture} />;
}
