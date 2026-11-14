# App Deploy

When the user asks to deploy a registered app, call app_deploy with its verified registered app ID and the user's request as requestText. Do not replace the requested app ID with a lecture template. The same tool serves TUI and PWA chat. The legacy lecture-scrap template retains its existing publisher; unsupported templates fail closed. Generated static-export artifacts use the member-owned app.publish@1 simulate/publish/undo capability.

The tool builds the registered template in an isolated test universe and requires a passing simulation receipt. It asks `배포` with `y` and `N` (default `N`) immediately before public publishing. Only an explicit `y` publishes. Return the tool's structured `kind: "site-deploy"` status and the `publicUrl` only when published. A `simulated` result means the public publish hook is unavailable; do not invent a URL or use a shell publishing path.
