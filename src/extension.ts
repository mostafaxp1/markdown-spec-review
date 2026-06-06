import * as vscode from 'vscode';
import type MarkdownIt from 'markdown-it';
import { registerCommands } from './commands';
import { commentPlugin } from './markdownItComments';
import { CommentViewerPanel } from './viewerPanel';

export function activate(context: vscode.ExtensionContext) {
  registerCommands(context);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdownSpecReview.openInteractiveView',
      async (uri?: vscode.Uri) => {
        // Invoked from the Explorer or an editor-tab context menu, VS Code passes
        // the right-clicked file's URI — which may not be the active editor (or
        // open at all). Open it as a text editor first so openReplacing can swap
        // that tab for the view. With no URI (command palette / keybinding /
        // title icon) fall back to the active editor.
        if (uri instanceof vscode.Uri) {
          const doc = await vscode.workspace.openTextDocument(uri);
          const editor = await vscode.window.showTextDocument(doc, { preview: false });
          await CommentViewerPanel.openReplacing(context, editor);
          return;
        }
        await CommentViewerPanel.openReplacing(context, vscode.window.activeTextEditor);
      }
    ),
    vscode.commands.registerCommand('markdownSpecReview.revertToSource', () =>
      CommentViewerPanel.revertActive()
    ),
    vscode.commands.registerCommand('markdownSpecReview.addressComments', () => {
      if (!CommentViewerPanel.addressActive()) {
        vscode.window.showWarningMessage(
          'Markdown Spec Review: open the Interactive Comments View to address comments with AI.'
        );
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor || editor.document.languageId !== 'markdown') return;
      const cfg = vscode.workspace.getConfiguration('markdownSpecReview');
      if (!cfg.get<boolean>('openInViewerByDefault', false)) return;
      if (CommentViewerPanel.hasPanel(editor.document.uri)) return;
      CommentViewerPanel.openReplacing(context, editor);
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
