# Terminal Threads

Independent terminal threads in VS Code's right sidebar, with history kept (encrypted) across restarts. Personal build for macOS arm64 and Linux x64/arm64, including Remote-SSH.

Build and test: `npm ci && npm run build && npm test`
Package (one file for macOS arm64 and Linux x64/arm64, using node-pty's own prebuilds): `npx vsce package --allow-missing-repository --skip-license`
Linux tests: run `npm ci && npm test` in an AlmaLinux 8 container (glibc 2.28, VS Code's remote floor) with perl and procps-ng installed.
Install: `code --install-extension terminal-threads-0.1.0.vsix` (for Remote-SSH, install it from the Extensions view while connected).
