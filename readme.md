# Terminal Threads

Independent terminal threads in VS Code's right sidebar. History is kept across restarts. Personal build, macOS arm64 only.

Build: `npm ci && npm run build && npm test`
Install: `npx vsce package --target darwin-arm64 --allow-missing-repository --skip-license && code --install-extension terminal-threads-darwin-arm64-*.vsix`
