# Contributing to elanous

Thank you for helping.

## How to contribute

1. **Bugs and small fixes** — open a pull request. Include a failing test or the command
   that reproduces the problem.
2. **New features or architecture changes** — open an issue first. Planning happens in
   issues, not in files committed to the repository.
3. **Questions** — open a discussion.

## Development setup

```bash
bun install
bun bin/elanous.mjs doctor      # what is configured, what is missing
bun test <path>                 # tests for the files you changed
bun run scripts/ci-typecheck-changed.ts   # type errors in the files you changed
```

See `AGENTS.md` for the working agreement that both humans and coding agents follow.

## How this repository is published

This public repository is exported from a private source repository. Maintainers merge
accepted pull requests here and carry them back to the source, so your authorship is kept.
Internal planning documents are not part of the public tree.

## License

By contributing you agree that your contributions are licensed under the Apache License 2.0
(see `LICENSE`).
