import * as vscode from 'vscode';
import type MarkdownIt from 'markdown-it';
import { registerCommands } from './commands';
import { commentPlugin } from './markdownItComments';
import { CommentViewerPanel } from './viewerPanel';

export function activate(context: vscode.ExtensionContext) {
  registerCommands(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownComments.openInteractiveView', () =>
      CommentViewerPanel.openReplacing(context, vscode.window.activeTextEditor)
    ),
    vscode.commands.registerCommand('markdownComments.revertToSource', () =>
      CommentViewerPanel.revertActive()
    ),
    vscode.commands.registerCommand('markdownComments.addressComments', () => {
      if (!CommentViewerPanel.addressActive()) {
        vscode.window.showWarningMessage(
          'Markdown Comments: open the Interactive Comments View to address comments with AI.'
        );
      }
    })
  );

  // Returned to the built-in Markdown preview so our plugin participates in
  // rendering. See `markdown.markdownItPlugins` in package.json. Unchanged: the
  // built-in preview keeps rendering read-only bubbles.
  return {
    extendMarkdownIt(md: MarkdownIt) {
      return md.use(commentPlugin);
    },
  };
}

export function deactivate() {
  CommentViewerPanel.disposeAll();
}
