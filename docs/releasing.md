# Releasing agentq

Releases are published from GitHub Actions with npm trusted publishing. The workflow uses a
short-lived OIDC identity, contains no npm token, and lets npm generate package provenance.

## One-time npm setup

After the package exists on npm, configure its trusted publisher with these exact values:

- Provider: GitHub Actions
- Organization or user: `Luke-Pitstick`
- Repository: `agentq`
- Workflow filename: `release.yml`
- Allowed action: `npm publish`

Protect release tags in GitHub before enabling publishing. The package repository URL is
case-sensitive and must continue to match this public repository.

## Publish a version

1. Update `version` in `package.json`. Refresh `bun.lock` only when dependency metadata changes.
2. Run `bun run check` and inspect `npm pack --dry-run`.
3. Merge the version change to `main`.
4. Create a GitHub release whose tag is exactly `v<package version>`.

Publishing the release triggers `.github/workflows/release.yml`. The workflow re-runs the full
cross-package checks, verifies the tag, inspects the npm archive, and publishes publicly. npm
trusted publishing automatically attaches provenance for the public repository/package.

The first-ever package publication may require an npm owner to publish once interactively before
the trusted-publisher relationship can be configured. Do not add a long-lived npm token to the
repository.
