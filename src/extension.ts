import * as vscode from 'vscode';
import { ThreadsViewProvider, VIEW_ID } from './view.ts';

let provider: ThreadsViewProvider | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const p = new ThreadsViewProvider(context);
  provider = p;
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, p, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('terminalThreads.new', () => p.newThread()),
    vscode.commands.registerCommand('terminalThreads.rename', (ctx?: { threadId?: unknown }) => p.renameThread(ctx?.threadId)),
  );
}

// Saves every thread's history before the extension host shuts down.
export function deactivate(): Promise<void> | undefined {
  return provider?.dispose();
}
