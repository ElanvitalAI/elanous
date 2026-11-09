# App Deploy

When the user asks to create and deploy the lecture notes and scrap app, call `app_deploy` with `appId: "lecture-scrap"` and the user's request as `requestText`. The same tool serves TUI and PWA chat.

The tool builds the registered template in an isolated test universe and requires a passing simulation receipt. It asks `배포` with `y` and `N` (default `N`) immediately before public publishing. Only an explicit `y` publishes. Return the tool's structured `kind: "site-deploy"` status and the `publicUrl` only when published. A `simulated` result means the public publish hook is unavailable; do not invent a URL or use a shell publishing path.
