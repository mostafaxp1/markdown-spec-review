import * as vscode from 'vscode';
import {
  buildNewBlock,
  buildEditedBlock,
  computeInsert,
  computeRemoveRange,
  findCommentAt,
  maybeAutoSaveComment,
} from './docEdits';
import { CommentViewerPanel } from './viewerPanel';

function requireMarkdownEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'markdown') {
    vscode.window.showWarningMessage('Markdown Spec Review: open a Markdown file first.');
    return undefined;
  }
  return editor;
}

async function addComment(): Promise<void> {
  // The interactive Comments view is a webview, not a text editor: when it has
  // focus there's no active Markdown editor (its source tab is usually closed),
  // so hand the add flow to the view itself instead of warning the user.
  if (CommentViewerPanel.addCommentToActive()) {
    return;
  }

  const editor = requireMarkdownEditor();
  if (!editor) {
    return;
  }

  const body = await vscode.window.showInputBox({
    prompt: 'Comment',
    placeHolder: 'Type your comment for this section…',
    ignoreFocusOut: true,
  });
  if (body === undefined || body.trim() === '') {
    return;
  }

  const block = buildNewBlock(body);
  const { position, text } = computeInsert(editor.document, editor.selection.end.line, block);
  if (await editor.edit((b) => b.insert(position, text))) {
    await maybeAutoSaveComment(editor.document);
  }
}

async function editComment(): Promise<void> {
  const editor = requireMarkdownEditor();
  if (!editor) {
    return;
  }

  const found = findCommentAt(editor.document, editor.selection.active);
  if (!found) {
    vscode.window.showInformationMessage('Markdown Spec Review: no comment at the cursor.');
    return;
  }

  const body = await vscode.window.showInputBox({
    prompt: 'Edit comment',
    value: found.parsed.body,
    ignoreFocusOut: true,
  });
  if (body === undefined) {
    return;
  }

  const updated = buildEditedBlock(found.parsed, body);
  if (await editor.edit((b) => b.replace(found.range, updated))) {
    await maybeAutoSaveComment(editor.document);
  }
}

async function removeComment(): Promise<void> {
  const editor = requireMarkdownEditor();
  if (!editor) {
    return;
  }

  const found = findCommentAt(editor.document, editor.selection.active);
  if (!found) {
    vscode.window.showInformationMessage('Markdown Spec Review: no comment at the cursor.');
    return;
  }

  const delRange = computeRemoveRange(editor.document, found.range);
  if (await editor.edit((b) => b.delete(delRange))) {
    await maybeAutoSaveComment(editor.document);
  }
}

export function registerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownComments.addComment', addComment),
    vscode.commands.registerCommand('markdownComments.editComment', editComment),
    vscode.commands.registerCommand('markdownComments.removeComment', removeComment)
  );
}
