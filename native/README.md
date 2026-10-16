# Experimental Mün native backend

This directory retains the Rust runtime and platform renderer experiments.
The supported default project direction is the SwiftUI-inspired JavaScript web
frontend (`@mun/core` + `@mun/web`), not this backend.

Native scaffolding is explicitly opt-in:

```bash
mun create NativeExperiment --target native
cd NativeExperiment
mun dev
```

Native projects use `mun.toml` and `Sources/App.mun`. The native runtime, native
packaging, and platform integration are experimental and are not prerequisites
for building, running, or deploying a web app.

See [native architecture](../docs/NATIVE_ARCHITECTURE.md),
[native projects](../docs/native-projects.md), and the current
[framework architecture](../docs/ARCHITECTURE.md).
