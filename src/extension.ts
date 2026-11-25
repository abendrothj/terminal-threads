import * as vscode from 'vscode';
import nodePty from 'node-pty';

// Task 0 gate: one shell wired straight to the webview. Replaced by the thread manager in Task 6.
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('terminalThreads.view', {
      resolveWebviewView(view) {
        const dist = vscode.Uri.joinPath(context.extensionUri, 'dist');
        view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
        const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
        const src = (f: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(dist, f));
        const csp = `default-src 'none'; style-src ${view.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${view.webview.cspSource};`;
        view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${src('xterm.css')}">
<style>html,body,#term{height:100%;margin:0;padding:0;overflow:hidden}</style>
</head><body><div id="term"></div><script nonce="${nonce}" src="${src('webview.js')}"></script></body></html>`;

        let pty: nodePty.IPty | undefined;
        view.webview.onDidReceiveMessage((msg: { type: string; data?: string; cols?: number; rows?: number }) => {
          if (msg.type === 'ready' && !pty && msg.cols && msg.rows) {
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.HOME;
            pty = nodePty.spawn(process.env.SHELL ?? '/bin/zsh', ['-l'], { name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd, env: process.env });
            pty.onData((data) => void view.webview.postMessage({ type: 'data', data }));
          } else if (msg.type === 'input' && msg.data) {
            pty?.write(msg.data);
          } else if (msg.type === 'resize' && msg.cols && msg.rows) {
            pty?.resize(msg.cols, msg.rows);
          }
        });
        view.onDidDispose(() => pty?.kill());
      },
    }, { webviewOptions: { retainContextWhenHidden: true } }),
  );
}

export function deactivate(): void {}
