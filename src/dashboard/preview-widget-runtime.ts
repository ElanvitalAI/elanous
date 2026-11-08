export interface DashboardPreviewWidgetLike {
  state: Record<string, unknown>;
  character?: string;
}

export interface DashboardPreviewTerminalProjection {
  text: string;
  focused: boolean;
  title: string;
}

export interface DashboardPreviewWidgetRuntime {
  projectTerminal(
    widget: DashboardPreviewWidgetLike | null | undefined,
    projection: DashboardPreviewTerminalProjection,
  ): void;
  projectPlain(
    widget: DashboardPreviewWidgetLike | null | undefined,
    projection: {
      text: string;
      scroll: number;
      focused: boolean;
      title: string;
    },
  ): void;
}

export function createDashboardPreviewWidgetRuntime(): DashboardPreviewWidgetRuntime {
  return {
    projectTerminal(widget, projection) {
      if (!widget) return;
      widget.state.text = projection.text;
      widget.state.scroll = 0;
      widget.state.focused = projection.focused;
      widget.state.preformatted = true;
      widget.character = projection.title;
    },
    projectPlain(widget, projection) {
      if (!widget) return;
      widget.state.text = projection.text;
      widget.state.scroll = projection.scroll;
      widget.state.focused = projection.focused;
      widget.state.preformatted = true;
      widget.character = projection.title;
    },
  };
}
