# Terminal Threads

Independent terminal threads in VS Code's right sidebar, with history kept (encrypted) across restarts. Personal build for macOS arm64 and Linux x64/arm64, including Remote-SSH.

Build and test: `npm ci && npm run build && npm test`
macOS package: `npx vsce package --target darwin-arm64 --allow-missing-repository --skip-license`
Linux packages: build in an AlmaLinux 8 container (glibc 2.28) with gcc-toolset-13 and Python 3.11, compile node-pty with node-gyp (npm holds its install script back), remove `node_modules/node-pty/prebuilds`, then `vsce package --target linux-x64` or `linux-arm64`.
Install: `code --install-extension <file>.vsix` (for Remote-SSH, install the Linux package from the Extensions view while connected).
