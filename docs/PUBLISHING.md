# Publishing Mün to npm

Mün publishes every non-private package in the repository root and `packages/*` as one synchronized release. The current set is eleven packages:

1. `@mun/execution`
2. `@mun/animation`
3. `@mun/core`
4. `@mun/compiler`
5. `@mun/legacy-react`
6. `@mun/react`
7. `@mun/vite`
8. `@mun/vue`
9. `@mun/web`
10. `mun`
11. `create-mun`

The repository includes a release helper that discovers these packages from their manifests and topologically sorts their internal dependencies. `@mun/animation` therefore publishes after `@mun/execution` and before packages such as `@mun/web` and `mun` that depend on it. Adding another non-private package under `packages/*` automatically adds it to both packing and publishing instead of requiring two hard-coded target lists to be kept in sync.

## One-time npm setup

Log in to npm first:

```bash
npm login
npm whoami
```

The scoped packages use `@mun/*`. If your npm username is not `mun`, the `mun` npm organization/scope must exist and your account must have publish access to it.

The script never stores an npm token or OTP. Authentication is handled by the normal npm CLI. If npm requires a one-time password during direct publishing, enter it when npm asks for it.

## Inspect the release plan

This does not build, contact npm, change versions, or publish anything:

```bash
pnpm release:plan
```

## Dry run

Run the release checks, build the actual tarballs, then ask npm to perform a publish dry-run for all packages:

```bash
pnpm release:dry
```

## Publish the current version

```bash
pnpm release
```

The command:

1. refuses a dirty Git tree by default;
2. runs the normal release gate (`pnpm test` plus a built React/Web production smoke);
3. creates fresh tarballs with `pnpm pack`;
4. verifies that no packed manifest contains `workspace:` dependencies;
5. verifies npm authentication;
6. asks for final confirmation;
7. publishes packages in dependency order;
8. skips an identical version that is already on npm and repairs the requested dist-tag if necessary, so an interrupted release can be resumed safely.

Pressing `Ctrl-C` is a hard cancellation boundary. The helper forwards `SIGINT` to the active check/build/package process tree, kills any stubborn descendants, exits with status 130, and does not advance to the next release phase. Temporary version changes are restored before it exits.

## Bump and publish

All publishable Mün packages always share one version. For a bumped release, the helper temporarily versions the manifests while creating the release tarballs, restores the checkout before npm publication, then persists the new versions only after the whole release succeeds. This keeps a failed or partially published release rerunnable without `--allow-dirty`:

```bash
pnpm release:patch
pnpm release:minor
pnpm release:major
```

For an explicit version or prerelease:

```bash
pnpm release -- --version 0.2.0-beta.1 --tag next
```

Stable versions default to the `latest` dist-tag. Versions containing a prerelease suffix default to `next`.

## Useful options

```bash
# Run pnpm test only and skip the production-browser smoke.
pnpm release -- --quick

# Run the exhaustive release gate: performance benchmarks, every demo/parity
# production build, and the complete seven-target Chromium validation matrix.
pnpm release -- --full

# Publish using a different dist-tag.
pnpm release -- --tag next

# Publish without the interactive final confirmation.
pnpm release -- --yes

# Allow uncommitted changes intentionally.
pnpm release -- --allow-dirty

# Pass npm provenance through in a supported CI environment.
pnpm release -- --provenance --yes

# Emergency-only: skip all validation.
pnpm release -- --skip-checks
```

Use `--skip-checks` only when the exact artifacts were already validated elsewhere. The normal release path is deliberately conservative.

The default release intentionally does not run performance benchmarks or the complete renderer/parity browser matrix. Those checks are useful for CI and milestone validation but are redundant and comparatively flaky as a mandatory npm-publish gate. Run `pnpm release -- --full` (or `pnpm run release:check:full`) when you want the exhaustive validation.

## Partial failure / resume

If npm accepts some packages and a later package fails, fix the npm/auth/network problem and run the same release command again. Before each real publish the helper queries npm for that exact `name@version`. Existing versions are skipped, their requested dist-tag is repaired if necessary, and the remaining packages continue in dependency order. A version bump is not left behind in source manifests until the complete publish succeeds.

Do not bump the version after a partial release unless you intentionally want to abandon that release and publish a new version.
