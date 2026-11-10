---
"typepeek": minor
---

Add an experimental Bun AOT build for host-native CLI and analysis-worker executables. Generated native packages run without an installed JavaScript runtime and retain the pinned TSRS compiler dependency. Keep the existing JavaScript package compatible with Node.js and npm, pnpm, and Bun installers.
