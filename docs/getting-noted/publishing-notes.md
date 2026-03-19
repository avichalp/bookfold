# Publishing Notes

Maintainer-only release notes for publishing Bookfold packages later.

## Scope

- the workspace root package is private and should not be published
- publish the public packages from their workspace directories instead

## Release Order

1. `bun publish --cwd packages/sdk --access public`
2. `bun publish --cwd packages/cli --access public`

## Notes

- `packages/cli` depends on `@bookfold/sdk` via `workspace:*`, so Bun rewrites that dependency to the current SDK version during publish
- the workspace is Bun-first for local development and publishing commands
- for local CLI linking, use `npm link --workspace bookfold` through `bun run link:bookfold`
- `bun link` at the repo root registers the private workspace package instead of the public CLI
