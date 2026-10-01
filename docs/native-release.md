# Native host release assembly

`@mun/ui` ships a prebuilt `mun-native` host per OS/architecture under
`native/bin/<platform>-<arch>/`. `mun run` uses that host; it never compiles
Rust on an installed consumer's machine.

## Assembling a host

```bash
node scripts/assemble-native-host.mjs --out <staging-dir>
```

- Builds `mun-native` with `cargo build --release --locked` (pass
  `--target <rust-triple>` to cross-build, e.g. `x86_64-apple-darwin`).
- Copies it to `<staging-dir>/native/bin/<platform>-<arch>/` and writes
  `mun-native.json` beside it:

  | field | meaning |
  | --- | --- |
  | `packageVersion` | the `@mun/ui` version the host was assembled for |
  | `semanticUiIrVersion` | IR version the host accepts (from `mun-native --host-info`) |
  | `platform`, `arch`, `target` | Node platform/arch key and Rust triple |
  | `profile` | `release` for published hosts |
  | `sha256` | digest of the assembled executable |
  | `signed` | `false` until the external signing step below replaces the binary |

- A natively runnable host is asked for `--host-info` and must report the
  requested profile. Cross-built hosts are recorded without that check.

`scripts/verify-native-package.mjs` runs exactly this assembly into an isolated
stage, packs every workspace package, installs them into a fresh consumer,
launches the installed host on compiled `NativeProductionSmoke.mun`, and checks
that a host with stale metadata or a missing platform host is rejected with a
clear error instead of falling back to Cargo.

## What the launcher enforces

`bin/native.mjs` resolves the host in this order:

1. `MUN_NATIVE_HOST` (explicit override, no metadata check).
2. The packaged host for `process.platform-process.arch`. Its `mun-native.json`
   must match the installed package version, the compiled program's IR version
   and the platform/arch; any mismatch is an error naming the field.
3. Building from source with Cargo — only in a repository checkout, or with
   `MUN_NATIVE_BUILD_FROM_SOURCE=1`.

## Signing and notarization (external, not automated here)

The repository holds no signing identities, so nothing here signs, and no
placeholder signature is produced. A release pipeline that has credentials runs
these after assembly and before packing, then updates `sha256` and sets
`signed: true` in `mun-native.json`:

- **macOS**: `codesign --force --options runtime --timestamp --sign "Developer ID Application: …" mun-native`,
  then submit a zip with `xcrun notarytool submit … --wait`. A bare executable
  cannot be stapled; Gatekeeper checks the notarization ticket online.
- **Windows**: `signtool sign /fd SHA256 /tr <timestamp-url> /td SHA256 /f <cert> mun-native.exe`.
- **Linux**: publish detached signatures or checksums alongside the package as
  the distribution channel requires.

Until that step exists, published hosts are unsigned: macOS users who download
the package outside npm may see Gatekeeper prompts.
