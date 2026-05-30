/**
 * The interactive Comments view: a custom WebviewPanel that renders the
 * Markdown document with our comment bubbles and lets the user add / edit /
 * remove comments directly from the view via a popup — the thing the built-in
 * (read-only) preview cannot do, because it gives extensions no channel back.
 *
 * One panel per document URI. The webview is a pure presentation/event surface;
 * the extension host is the single source of truth: it renders the HTML, and on
 * every mutation it re-resolves positions against the LIVE TextDocument (gated
 * by a document-version guard) before applying an undoable WorkspaceEdit.
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { promises as fsp } from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { renderDocumentHtml } from './webviewRenderer';
import {
  buildNewBlock,
  buildEditedBlock,
  computeInsert,
  computeRemoveRange,
  commentIndexAtOffset,
  findCommentByIndex,
  findCommentByContent,
  findResolvedComments,
  matchesFingerprint,
  maybeAutoSaveComment,
  getAuthor,
  getDate,
  CommentFingerprint,
  FoundComment,
} from './docEdits';
import {
  AgentId,
  Effort,
  EFFORTS,
  getAiSettings,
  agentLabel,
  resolveBin,
  isAgentInstalled,
  detectModels,
  extractComments,
  buildInstructions,
  buildInvocation,
  toCommandLine,
} from './aiAgents';

const panels = new Map<string, CommentViewerPanel>();

const VIEW_TYPE = 'markdownComments.interactiveView';

function getNonce(): string {
  return crypto.randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

type ColorTheme = 'vscode' | 'light' | 'dark' | 'light-modern' | 'dark-modern';

const COLOR_THEMES: ColorTheme[] = ['vscode', 'light', 'dark', 'light-modern', 'dark-modern'];

const THEME_CLASS: Record<ColorTheme, string> = {
  vscode: '',
  light: 'mdc-theme-light',
  dark: 'mdc-theme-dark',
  'light-modern': 'mdc-theme-light-modern',
  'dark-modern': 'mdc-theme-dark-modern',
};

interface ViewerConfig {
  fontSize: number;
  maxWidth: number;
  colorTheme: ColorTheme;
}

function getViewerConfig(): ViewerConfig {
  const cfg = vscode.workspace.getConfiguration('markdownComments');
  const fontSize = Math.max(8, Math.min(cfg.get<number>('viewer.fontSize', 15), 40));
  const maxWidth = Math.max(0, cfg.get<number>('viewer.maxWidth', 1100));
  const theme = cfg.get<string>('viewer.colorTheme', 'vscode') as ColorTheme;
  const colorTheme = COLOR_THEMES.includes(theme) ? theme : 'vscode';
  return { fontSize, maxWidth, colorTheme };
}

/** The AI config the webview needs to render its "Address comments" bar (agent
 *  label + current defaults). Installed-state and the model list arrive
 *  separately via an `aiInfo` message, since detecting them runs CLIs. */
function getAiConfigForWebview() {
  const s = getAiSettings();
  return {
    agent: s.agent,
    label: agentLabel(s.agent),
    runMode: s.runMode,
    model: s.model,
    effort: s.effort,
  };
}

/** Shared output channel for headless agent runs (created on first use). */
let aiOutput: vscode.OutputChannel | undefined;
function getAiOutput(): vscode.OutputChannel {
  if (!aiOutput) {
    aiOutput = vscode.window.createOutputChannel('Markdown Comments AI');
  }
  return aiOutput;
}

// --- "review changes" diff support -----------------------------------------
// The agent edits the file in place, so to let the user review/approve we keep
// a pre-run snapshot and expose it through a read-only virtual document the
// VS Code diff editor can show on the left, against the live (revised) file on
// the right. Snapshots are keyed by an opaque token carried in the URI's query.
const MDC_ORIGINAL_SCHEME = 'mdc-comments-original';
const originalSnapshots = new Map<string, string>();
let originalProviderRegistered = false;

function ensureOriginalProvider(context: vscode.ExtensionContext): void {
  if (originalProviderRegistered) {
    return;
  }
  originalProviderRegistered = true;
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(MDC_ORIGINAL_SCHEME, {
      provideTextDocumentContent(uri) {
        return originalSnapshots.get(uri.query) ?? '';
      },
    })
  );
}

function originalDiffUri(token: string, name: string): vscode.Uri {
  return vscode.Uri.from({ scheme: MDC_ORIGINAL_SCHEME, path: `/${name}`, query: token });
}

export class CommentViewerPanel {
  static createOrShow(
    context: vscode.ExtensionContext,
    document: vscode.TextDocument | undefined,
    preferredColumn?: vscode.ViewColumn
  ): void {
    if (!document || document.languageId !== 'markdown') {
      vscode.window.showWarningMessage('Markdown Comments: open a Markdown file first.');
      return;
    }

    const column = preferredColumn ?? vscode.ViewColumn.Beside;

    const key = document.uri.toString();
    const existing = panels.get(key);
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn ?? column);
      return;
    }

    const localResourceRoots = [vscode.Uri.joinPath(context.extensionUri, 'media')];
    if (document.uri.scheme === 'file') {
      localResourceRoots.push(vscode.Uri.joinPath(document.uri, '..'));
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `Comments: ${pathBasename(document.uri)}`,
      { viewColumn: column, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots,
      }
    );

    const instance = new CommentViewerPanel(context, panel, document.uri);
    panels.set(key, instance);
  }

  /**
   * Open the Comments view *in place of* the Markdown editor: the view takes
   * over the editor's column and its source tab is closed, so the two are a
   * single toggleable surface rather than side-by-side panes. `revertToSource`
   * is the inverse. Untitled buffers are the exception — closing one discards
   * the document and would orphan the view, so there we keep the source tab.
   */
  static async openReplacing(
    context: vscode.ExtensionContext,
    editor: vscode.TextEditor | undefined
  ): Promise<void> {
    const document = editor?.document;
    if (!document || document.languageId !== 'markdown') {
      vscode.window.showWarningMessage('Markdown Comments: open a Markdown file first.');
      return;
    }

    // Capture the source tab before the view opens, so we can close exactly the
    // tab the user invoked this from (the doc may be open in other columns too).
    const sourceTab = findTextTab(document.uri, editor.viewColumn);
    const column = editor.viewColumn ?? vscode.ViewColumn.Active;

    CommentViewerPanel.createOrShow(context, document, column);

    if (sourceTab && document.uri.scheme !== 'untitled') {
      try {
        await vscode.window.tabGroups.close(sourceTab);
      } catch {
        /* the source tab is already gone — nothing to replace */
      }
    }
  }

  /** Flip the active Comments view back to its Markdown source (inverse of
   *  `openReplacing`): wired to the "Show Markdown Source" title-bar icon. */
  static async revertActive(): Promise<void> {
    const active = Array.from(panels.values()).find((p) => p.panel.active);
    if (active) {
      await active.revertToSource();
    }
  }

  /**
   * Run "Add Comment" inside the focused Comments view, if one is focused. The
   * view owns the add flow there (the source editor is closed or in another
   * column), so it picks the hovered/visible block and opens the add popup.
   * Returns true when handled, so the command knows not to fall back to the
   * editor path and warn that no Markdown file is open.
   */
  static addCommentToActive(): boolean {
    const active = Array.from(panels.values()).find((p) => p.panel.active);
    if (!active) {
      return false;
    }
    void active.panel.webview.postMessage({ type: 'requestAdd' });
    return true;
  }

  /**
   * Trigger "Address comments with AI" in the focused Comments view, if one is
   * focused. The webview owns the model/effort selection in its bar, so we ask
   * it to run with whatever is currently picked there. Returns true when handled.
   */
  static addressActive(): boolean {
    const active = Array.from(panels.values()).find((p) => p.panel.active);
    if (!active) {
      return false;
    }
    void active.panel.webview.postMessage({ type: 'requestAddress' });
    return true;
  }

  static disposeAll(): void {
    for (const p of Array.from(panels.values())) {
      p.panel.dispose();
    }
    panels.clear();
    aiOutput?.dispose();
    aiOutput = undefined;
  }

  private disposables: vscode.Disposable[] = [];
  private debounce: ReturnType<typeof setTimeout> | undefined;
  /** The document version currently reflected in the webview. */
  private renderedVersion = -1;
  /** The run currently in flight (target + label), or undefined when idle. */
  private aiActiveRun: { docPath: string; label: string } | undefined;
  /** The spawned headless agent process while running (for Stop). */
  private aiChild: ChildProcess | undefined;
  /** The integrated terminal a terminal-mode run is using (for Stop / finish). */
  private aiTerminal: vscode.Terminal | undefined;
  /** Set when the user asks to stop, so the exit path reports a stop, not a fail. */
  private aiStopRequested = false;
  /** Pre-run snapshot of the document, enabling review / approve / revert. */
  private aiSnapshot: { original: string; token: string } | undefined;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    readonly panel: vscode.WebviewPanel,
    private readonly uri: vscode.Uri
  ) {
    this.panel.webview.html = this.buildHtml();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (msg) => void this.onMessage(msg),
      null,
      this.disposables
    );

    vscode.workspace.onDidChangeTextDocument(
      (e) => this.onDocumentChanged(e),
      null,
      this.disposables
    );

    // Re-render when the viewer's appearance settings change, so font size /
    // width / color theme update live without reopening the view.
    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration('markdownComments')) {
          void this.postUpdate();
        }
        // Changing the agent (or its binary override) changes which models and
        // installed-state the bar should show — re-detect.
        if (
          e.affectsConfiguration('markdownComments.ai.agent') ||
          e.affectsConfiguration('markdownComments.ai.commands')
        ) {
          void this.refreshAiInfo();
        }
      },
      null,
      this.disposables
    );

    // If the underlying document is closed, the view is now orphaned — for a
    // file we can reopen on demand, but an untitled doc cannot be recovered.
    vscode.workspace.onDidCloseTextDocument(
      (doc) => {
        if (doc.uri.toString() === this.uri.toString() && this.uri.scheme === 'untitled') {
          this.panel.dispose();
        }
      },
      null,
      this.disposables
    );

    // A terminal-mode run finishes when the user closes (or we Stop) its
    // terminal — that's our cue to offer the review/approve step.
    vscode.window.onDidCloseTerminal(
      (term) => {
        if (term === this.aiTerminal) {
          void this.finishRun({});
        }
      },
      null,
      this.disposables
    );
  }

  private dispose(): void {
    panels.delete(this.uri.toString());
    // A headless agent is tied to this view — don't leave it editing the file
    // after the view is gone. A terminal-mode run is the user's to manage.
    if (this.aiChild) {
      try {
        this.aiChild.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      this.aiChild = undefined;
    }
    this.clearSnapshot();
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = undefined;
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  /** Reopen this view's Markdown source in the view's column, then dispose the
   *  webview — the source editor lands where the view was, replacing it. */
  private async revertToSource(): Promise<void> {
    const doc = await this.getDocument();
    if (!doc) {
      this.postError('The Markdown source is no longer available.', 'NOT_FOUND');
      return;
    }
    const column = this.panel.viewColumn ?? vscode.ViewColumn.Active;
    await vscode.window.showTextDocument(doc, { viewColumn: column, preview: false });
    this.panel.dispose();
  }

  // -- document access -------------------------------------------------------

  private liveDocument(): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === this.uri.toString()
    );
  }

  private async getDocument(): Promise<vscode.TextDocument | undefined> {
    const open = this.liveDocument();
    if (open) {
      return open;
    }
    if (this.uri.scheme === 'untitled') {
      return undefined;
    }
    try {
      return await vscode.workspace.openTextDocument(this.uri);
    } catch {
      return undefined;
    }
  }

  // -- rendering / sync ------------------------------------------------------

  private onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    if (e.document.uri.toString() !== this.uri.toString()) {
      return;
    }
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      const doc = this.liveDocument();
      if (doc && doc.version !== this.renderedVersion) {
        void this.postUpdate(doc);
      }
    }, 150);
  }

  private async postUpdate(doc?: vscode.TextDocument): Promise<void> {
    const document = doc ?? (await this.getDocument());
    if (!document) {
      return;
    }
    this.renderedVersion = document.version;
    this.panel.webview.postMessage({
      type: 'update',
      html: renderDocumentHtml(document.getText()),
      version: document.version,
      config: {
        defaultAuthor: getAuthor(),
        today: getDate(),
        ...getViewerConfig(),
        ai: getAiConfigForWebview(),
      },
    });
  }

  private postError(message: string, code: 'STALE' | 'NOT_FOUND' | 'GENERIC'): void {
    this.panel.webview.postMessage({ type: 'error', message, code });
  }

  private postFocus(commentIndex: number): void {
    this.panel.webview.postMessage({ type: 'focusComment', commentIndex });
  }

  /** Re-push fresh state after rejecting a stale edit, so the user can retry. */
  private async staleRetry(doc?: vscode.TextDocument): Promise<void> {
    this.postError('The document changed since this view was rendered — please try again.', 'STALE');
    await this.postUpdate(doc);
  }

  // -- message handling ------------------------------------------------------

  private async onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case 'ready':
        await this.postUpdate();
        void this.refreshAiInfo();
        this.restoreAiPhase();
        break;
      case 'addressComments':
        await this.handleAddress(msg);
        break;
      case 'stopAddress':
        this.handleStop();
        break;
      case 'reviewChanges':
        await this.handleReview();
        break;
      case 'approveChanges':
        this.handleApprove();
        break;
      case 'rejectChanges':
        await this.handleReject();
        break;
      case 'addComment':
        await this.handleAdd(msg);
        break;
      case 'editComment':
        await this.handleEdit(msg);
        break;
      case 'removeComment':
        await this.handleRemove(msg);
        break;
      case 'removeAllResolved':
        await this.handleRemoveResolved(msg);
        break;
      case 'revealInEditor':
        await this.handleReveal(msg);
        break;
      case 'openLink':
        await this.handleOpenLink(msg);
        break;
    }
  }

  /** Resolve a comment the webview referenced, preferring index but requiring
   *  the content fingerprint to match; otherwise fall back to a content search. */
  private locate(
    doc: vscode.TextDocument,
    index: number,
    orig: CommentFingerprint | undefined
  ): FoundComment | null {
    const byIndex = findCommentByIndex(doc, index);
    if (!orig) {
      return byIndex;
    }
    if (byIndex && matchesFingerprint(byIndex.parsed, orig)) {
      return byIndex;
    }
    return findCommentByContent(doc, orig);
  }

  private async handleAdd(msg: any): Promise<void> {
    const doc = await this.getDocument();
    if (!doc) {
      this.postError('Document is not available.', 'GENERIC');
      return;
    }
    if (doc.version !== msg.docVersion) {
      await this.staleRetry(doc);
      return;
    }
    const body = String(msg.body ?? '');
    if (body.trim() === '') {
      return;
    }
    const sourceEnd = Number(msg.sourceEnd);
    if (!Number.isFinite(sourceEnd)) {
      return;
    }

    const block = buildNewBlock(body);
    // token.map's end line is EXCLUSIVE, so the block's last content line is
    // sourceEnd - 1; computeInsert walks from there to the true end of block.
    const { position, text } = computeInsert(doc, sourceEnd - 1, block);
    const baseOffset = doc.offsetAt(position);

    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, position, text);
    if (!(await vscode.workspace.applyEdit(edit))) {
      this.postError('Could not insert the comment.', 'GENERIC');
      return;
    }

    await maybeAutoSaveComment(doc);
    await this.postUpdate(doc);
    // The inserted block starts after the two-newline separator.
    const newIndex = commentIndexAtOffset(doc, baseOffset + text.length - block.length);
    this.postFocus(newIndex);
  }

  private async handleEdit(msg: any): Promise<void> {
    const doc = await this.getDocument();
    if (!doc) {
      this.postError('Document is not available.', 'GENERIC');
      return;
    }
    if (doc.version !== msg.docVersion) {
      await this.staleRetry(doc);
      return;
    }
    const located = this.locate(doc, Number(msg.commentIndex), msg.orig);
    if (!located) {
      this.postError('That comment could not be found — it may have changed.', 'NOT_FOUND');
      await this.postUpdate(doc);
      return;
    }
    const body = String(msg.body ?? '');
    const updated = buildEditedBlock(located.parsed, body);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, located.range, updated);
    if (!(await vscode.workspace.applyEdit(edit))) {
      this.postError('Could not update the comment.', 'GENERIC');
      return;
    }
    await maybeAutoSaveComment(doc);
    await this.postUpdate(doc);
    this.postFocus(Number(msg.commentIndex));
  }

  private async handleRemove(msg: any): Promise<void> {
    const doc = await this.getDocument();
    if (!doc) {
      this.postError('Document is not available.', 'GENERIC');
      return;
    }
    if (doc.version !== msg.docVersion) {
      await this.staleRetry(doc);
      return;
    }
    const located = this.locate(doc, Number(msg.commentIndex), msg.orig);
    if (!located) {
      this.postError('That comment could not be found — it may have changed.', 'NOT_FOUND');
      await this.postUpdate(doc);
      return;
    }
    const delRange = computeRemoveRange(doc, located.range);
    const edit = new vscode.WorkspaceEdit();
    edit.delete(doc.uri, delRange);
    if (!(await vscode.workspace.applyEdit(edit))) {
      this.postError('Could not remove the comment.', 'GENERIC');
      return;
    }
    await maybeAutoSaveComment(doc);
    await this.postUpdate(doc);
  }

  /**
   * Remove every resolved comment in one undoable edit. Resolution is decided
   * against the LIVE document (not what the webview rendered), so the set can't
   * drift; deletes are non-overlapping comment blocks, each with its leading
   * blank-line separator swallowed, so no double blank lines are left behind.
   */
  private async handleRemoveResolved(msg: any): Promise<void> {
    const doc = await this.getDocument();
    if (!doc) {
      this.postError('Document is not available.', 'GENERIC');
      return;
    }
    if (doc.version !== msg.docVersion) {
      await this.staleRetry(doc);
      return;
    }
    const resolved = findResolvedComments(doc);
    if (resolved.length === 0) {
      await this.postUpdate(doc);
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    for (const c of resolved) {
      edit.delete(doc.uri, computeRemoveRange(doc, c.range));
    }
    if (!(await vscode.workspace.applyEdit(edit))) {
      this.postError('Could not remove the resolved comments.', 'GENERIC');
      return;
    }
    await maybeAutoSaveComment(doc);
    await this.postUpdate(doc);
  }

  private async handleReveal(msg: any): Promise<void> {
    const doc = await this.getDocument();
    if (!doc) {
      return;
    }
    const line = Math.max(0, Math.min(Number(msg.sourceLine) || 0, doc.lineCount - 1));
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
    });
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }

  /**
   * Open a hyperlink the user clicked in the webview. The webview can't navigate
   * itself, so it relays the raw href here and we route it:
   *   - web / external URIs (http, https, mailto, …) → the default browser;
   *   - a `.md` file → its own interactive Comments view (a new tab);
   *   - any other file → a new editor tab.
   */
  private async handleOpenLink(msg: any): Promise<void> {
    const raw = typeof msg?.href === 'string' ? msg.href.trim() : '';
    if (!raw) {
      return;
    }

    // A leading `C:\` etc. is a Windows path, not a URI scheme — don't let the
    // drive letter be mistaken for one.
    const isWindowsDrive = /^[a-zA-Z]:[\\/]/.test(raw);
    const scheme = isWindowsDrive
      ? undefined
      : /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw)?.[1]?.toLowerCase();

    // Anything with a non-file scheme (http/https/mailto/tel/…) is a web link:
    // hand it to the OS so it opens in the browser / mail client.
    if (scheme && scheme !== 'file') {
      try {
        await vscode.env.openExternal(vscode.Uri.parse(raw));
      } catch {
        this.postError('Could not open that link.', 'GENERIC');
      }
      return;
    }

    const target = this.resolveFileTarget(raw, scheme === 'file');
    if (!target) {
      this.postError('Could not resolve that file path.', 'GENERIC');
      return;
    }

    const column = this.targetColumn();

    // A Markdown target gets the interactive Comments view, not a plain editor —
    // opened as a new tab in the right-hand panel where this view already lives.
    if (isMarkdownPath(target.path)) {
      try {
        const targetDoc = await vscode.workspace.openTextDocument(target);
        CommentViewerPanel.createOrShow(this.context, targetDoc, column);
      } catch {
        this.postError('Could not open that Markdown file.', 'GENERIC');
      }
      return;
    }

    // Everything else opens as a new editor tab in the same panel. `vscode.open`
    // (vs. showTextDocument) also handles binary files like images.
    try {
      await vscode.commands.executeCommand('vscode.open', target, {
        viewColumn: column,
        preview: false,
      });
    } catch {
      this.postError('Could not open that file.', 'GENERIC');
    }
  }

  /**
   * Where a clicked link should open. Prefer this view's own column so the new
   * tab lands in the right-hand panel the user is already looking at, instead
   * of spawning yet another column when several editor groups are open. Fall
   * back to the rightmost group, then to "beside".
   */
  private targetColumn(): vscode.ViewColumn {
    const columns = vscode.window.tabGroups.all
      .map((g) => g.viewColumn)
      .filter((c): c is vscode.ViewColumn => typeof c === 'number');
    if (columns.length > 1) {
      return 2 as vscode.ViewColumn;
    }
    if (this.panel.viewColumn) {
      return this.panel.viewColumn;
    }
    return vscode.ViewColumn.Beside;
  }

  /** Resolve a clicked file href to a Uri, relative to the viewed document. */
  private resolveFileTarget(raw: string, isFileUri: boolean): vscode.Uri | undefined {
    if (isFileUri) {
      try {
        return vscode.Uri.parse(raw);
      } catch {
        return undefined;
      }
    }

    // Drop any query / fragment, then undo the percent-encoding markdown-it
    // applies to hrefs (e.g. spaces → %20) so the path matches the filesystem.
    const cut = raw.search(/[?#]/);
    let pathPart = cut >= 0 ? raw.slice(0, cut) : raw;
    try {
      pathPart = decodeURIComponent(pathPart);
    } catch {
      /* keep pathPart as-is if it isn't valid percent-encoding */
    }
    if (!pathPart) {
      return undefined;
    }

    // Windows absolute path (C:\… or C:/…).
    if (/^[a-zA-Z]:[\\/]/.test(pathPart)) {
      return vscode.Uri.file(pathPart.replace(/\\/g, '/'));
    }

    // POSIX absolute path: reinterpret on the document's scheme/authority.
    if (pathPart.startsWith('/')) {
      return this.uri.with({ path: pathPart, query: '', fragment: '' });
    }

    // Relative path — only resolvable for an on-disk document, since an untitled
    // buffer has no directory to anchor against.
    if (this.uri.scheme === 'untitled') {
      return undefined;
    }
    const dir = vscode.Uri.joinPath(this.uri, '..');
    return vscode.Uri.joinPath(dir, pathPart);
  }

  // -- AI: address comments --------------------------------------------------

  private postAiStatus(
    state: 'running' | 'launched' | 'done' | 'error' | 'review',
    message = '',
    phase: 'idle' | 'running' | 'review' = 'idle'
  ): void {
    this.panel.webview.postMessage({ type: 'aiStatus', state, message, phase });
  }

  /** Detect the configured agent's installed-state and model list (runs CLIs),
   *  then push them to the webview so the bar can fill its model dropdown. */
  private async refreshAiInfo(): Promise<void> {
    const { agent } = getAiSettings();
    const [installed, models] = await Promise.all([
      isAgentInstalled(agent),
      detectModels(agent),
    ]);
    this.panel.webview.postMessage({ type: 'aiInfo', agent, installed, models });
  }

  /** After a webview reload (retainContextWhenHidden eviction), re-assert the
   *  current phase so the bar's Stop / review controls reappear. */
  private restoreAiPhase(): void {
    if (this.aiActiveRun) {
      this.postAiStatus(
        'running',
        `${this.aiActiveRun.label} is still running… Press Stop to cancel.`,
        'running'
      );
    } else if (this.aiSnapshot) {
      this.postAiStatus('review', 'Review the changes, then Approve or Revert.', 'review');
    }
  }

  /** Stash the document's pre-run text and register it for the review diff. */
  private captureSnapshot(original: string): void {
    this.clearSnapshot();
    ensureOriginalProvider(this.context);
    const token = getNonce();
    originalSnapshots.set(token, original);
    this.aiSnapshot = { original, token };
  }

  private clearSnapshot(): void {
    if (this.aiSnapshot) {
      originalSnapshots.delete(this.aiSnapshot.token);
      this.aiSnapshot = undefined;
    }
  }

  /**
   * Hand the document and its comments to the configured agent so it revises
   * the prose to address them. The webview supplies the per-run model/effort;
   * everything else (agent, run mode, binary) comes from settings.
   */
  private async handleAddress(msg: any): Promise<void> {
    if (this.aiActiveRun) {
      this.postAiStatus('error', 'An agent run is already in progress.', 'running');
      return;
    }

    const settings = getAiSettings();
    const agent = settings.agent;
    const runMode = settings.runMode;
    const model = typeof msg?.model === 'string' ? msg.model.trim() : settings.model;
    const effort: Effort = (EFFORTS as string[]).includes(msg?.effort)
      ? (msg.effort as Effort)
      : settings.effort;
    const label = agentLabel(agent);

    const doc = await this.getDocument();
    if (!doc) {
      this.postAiStatus('error', 'The Markdown document is not available.');
      return;
    }
    // The agent reads and edits the file on disk, so it must exist there and be
    // up to date — untitled buffers and unsaved edits are not visible to a CLI.
    if (doc.uri.scheme !== 'file') {
      this.postAiStatus('error', 'Save this file to disk before addressing comments with AI.');
      return;
    }
    if (doc.isDirty) {
      try {
        await doc.save();
      } catch {
        /* keep going — the agent reads whatever is on disk */
      }
    }

    const comments = extractComments(doc.getText());
    if (comments.length === 0) {
      this.postAiStatus('error', 'There are no comments to address.');
      return;
    }

    this.postAiStatus('running', `Checking ${label}…`, 'running');
    if (!(await isAgentInstalled(agent))) {
      this.postAiStatus(
        'error',
        `${label} ("${resolveBin(agent)}") was not found on your PATH. Set markdownComments.ai.commands or install it.`,
        'idle'
      );
      return;
    }

    const docPath = doc.uri.fsPath;
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const cwd = folder ? folder.uri.fsPath : path.dirname(docPath);
    const instructions = buildInstructions({ docPath, comments, effort });

    // Snapshot the saved-to-disk content so the run can be reviewed / reverted.
    this.captureSnapshot(doc.getText());
    this.aiActiveRun = { docPath, label };
    this.aiStopRequested = false;

    try {
      if (runMode === 'terminal') {
        await this.runInTerminal({ agent, model, effort, label, instructions, docPath, cwd });
      } else {
        this.runHeadless({ agent, model, effort, label, instructions, docPath, cwd });
      }
    } catch (err: any) {
      this.failRun(err?.message || 'Failed to start the agent.');
    }
  }

  /** Terminal mode: write the instructions to a temp file (keeps the command
   *  line short and quote-safe), then run the agent in an integrated terminal
   *  pointed at it so the user can watch the run. */
  private async runInTerminal(p: {
    agent: AgentId;
    model: string;
    effort: Effort;
    label: string;
    instructions: string;
    docPath: string;
    cwd: string;
  }): Promise<void> {
    const tmp = path.join(os.tmpdir(), `markdown-comments-${getNonce()}.md`);
    await fsp.writeFile(tmp, p.instructions, 'utf8');
    const prompt =
      `Follow the review instructions in ${tmp} exactly: edit ${p.docPath} in place to ` +
      `address each comment, append a "Resolved:" line to each comment body, then save the file.`;
    const inv = buildInvocation({ agent: p.agent, runMode: 'terminal', model: p.model, effort: p.effort, prompt });
    const cmd = toCommandLine(inv);

    const terminal = vscode.window.createTerminal({ name: `Address comments — ${p.label}`, cwd: p.cwd });
    this.aiTerminal = terminal;
    terminal.show(true);
    terminal.sendText(cmd, true);
    getAiOutput().appendLine(`[terminal] ${cmd}`);
    this.postAiStatus(
      'running',
      `Running ${p.label} in a terminal — approve edits there, then close it (or press Stop) to review.`,
      'running'
    );
  }

  /** Headless mode: spawn the agent non-interactively; it edits the file and we
   *  offer review when it exits. Output is streamed to the "Markdown Comments
   *  AI" channel, which is revealed on failure. */
  private runHeadless(p: {
    agent: AgentId;
    model: string;
    effort: Effort;
    label: string;
    instructions: string;
    docPath: string;
    cwd: string;
  }): void {
    const out = getAiOutput();
    const inv = buildInvocation({
      agent: p.agent,
      runMode: 'headless',
      model: p.model,
      effort: p.effort,
      prompt: p.instructions,
    });
    out.appendLine(`\n[${new Date().toISOString()}] $ ${toCommandLine(inv)} (cwd: ${p.cwd})`);

    let child: ChildProcess;
    try {
      child = spawn(inv.bin, inv.args, { cwd: p.cwd, windowsHide: true });
    } catch (err: any) {
      this.failRun(err?.message || 'Failed to start the agent.');
      return;
    }

    this.aiChild = child;
    this.postAiStatus('running', `${p.label} is addressing your comments… Press Stop to cancel.`, 'running');

    child.stdout?.on('data', (d) => out.append(d.toString()));
    child.stderr?.on('data', (d) => out.append(d.toString()));

    child.on('error', (err: NodeJS.ErrnoException) => {
      this.aiChild = undefined;
      const m =
        err.code === 'ENOENT'
          ? `${p.label} ("${inv.bin}") was not found on your PATH.`
          : err.message;
      out.appendLine(`\n[error] ${m}`);
      out.show(true);
      this.failRun(m);
    });

    child.on('close', (code) => {
      this.aiChild = undefined;
      if (this.aiStopRequested) {
        out.appendLine(`\n[stopped] ${p.label} was stopped.`);
        void this.finishRun({ note: `${p.label} stopped.` });
      } else if (code === 0) {
        out.appendLine(`\n[done] ${p.label} finished.`);
        void this.finishRun({});
      } else {
        out.appendLine(`\n[error] ${p.label} exited with code ${code}.`);
        out.show(true);
        void this.finishRun({
          note: `${p.label} exited with code ${code} — see the "Markdown Comments AI" output.`,
          error: true,
        });
      }
    });
  }

  /** Wrap up a run: refresh the view, then offer review if the file actually
   *  changed; otherwise report done/idle. Idempotent — a stray second call (e.g.
   *  both a Stop and the terminal-close event) just refreshes. */
  private async finishRun(o: { note?: string; error?: boolean }): Promise<void> {
    const run = this.aiActiveRun;
    this.aiActiveRun = undefined;
    this.aiChild = undefined;
    this.aiTerminal = undefined;
    this.aiStopRequested = false;
    if (!run) {
      await this.postUpdate();
      return;
    }

    let changed = false;
    try {
      const current = await fsp.readFile(run.docPath, 'utf8');
      changed = this.aiSnapshot != null && current !== this.aiSnapshot.original;
    } catch {
      /* if we can't read it, treat as no reviewable change */
    }
    await this.postUpdate();

    if (changed && this.aiSnapshot) {
      const prefix = o.note ? `${o.note} ` : `${run.label} finished. `;
      this.postAiStatus('review', `${prefix}Review the changes, then Approve or Revert.`, 'review');
    } else {
      this.clearSnapshot();
      this.postAiStatus(
        o.error ? 'error' : 'done',
        o.note || `${run.label} finished — no changes were made.`,
        'idle'
      );
    }
  }

  /** A run that produced no reviewable result (failed to start / hard error). */
  private failRun(message: string): void {
    this.aiActiveRun = undefined;
    this.aiChild = undefined;
    this.aiStopRequested = false;
    this.clearSnapshot();
    this.postAiStatus('error', message, 'idle');
  }

  /** Stop the in-flight run. The resulting process exit / terminal close routes
   *  through finishRun, so any partial edits are still offered for review. */
  private handleStop(): void {
    const run = this.aiActiveRun;
    if (!run) {
      this.postAiStatus('done', '', 'idle');
      return;
    }
    this.aiStopRequested = true;
    const out = getAiOutput();
    if (this.aiChild) {
      const child = this.aiChild;
      out.appendLine(`\n[stop] stopping ${run.label}…`);
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      // Escalate if it ignores SIGTERM; the 'close' handler runs finishRun.
      setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        } catch {
          /* already gone */
        }
      }, 2500);
      this.postAiStatus('running', `Stopping ${run.label}…`, 'running');
    } else if (this.aiTerminal) {
      out.appendLine(`\n[stop] closing the ${run.label} terminal…`);
      this.aiTerminal.dispose(); // fires onDidCloseTerminal -> finishRun
      this.postAiStatus('running', `Stopping ${run.label}…`, 'running');
    } else {
      void this.finishRun({ note: `${run.label} stopped.` });
    }
  }

  /** Open a diff of the pre-run original (left, read-only) against the revised
   *  file on disk (right) so the user can review the agent's changes. */
  private async handleReview(): Promise<void> {
    if (!this.aiSnapshot) {
      this.postAiStatus('error', 'There is nothing to review.', 'idle');
      return;
    }
    const name = pathBasename(this.uri);
    const left = originalDiffUri(this.aiSnapshot.token, `Original ${name}`);
    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        left,
        this.uri,
        `Address comments — original ↔ revised (${name})`,
        { preview: true, viewColumn: vscode.ViewColumn.Beside }
      );
    } catch {
      this.postAiStatus('error', 'Could not open the diff view.', 'review');
    }
  }

  /** Keep the agent's changes: just drop the snapshot and return to idle. */
  private handleApprove(): void {
    this.clearSnapshot();
    this.postAiStatus('done', 'Changes approved.', 'idle');
  }

  /** Reject the agent's changes: restore the snapshot via an undoable edit. */
  private async handleReject(): Promise<void> {
    if (!this.aiSnapshot) {
      this.postAiStatus('done', '', 'idle');
      return;
    }
    const doc = await this.getDocument();
    if (!doc) {
      this.postAiStatus('error', 'The document is not available.', 'review');
      return;
    }
    const original = this.aiSnapshot.original;
    const fullRange = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(doc.getText().length)
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, fullRange, original);
    if (!(await vscode.workspace.applyEdit(edit))) {
      this.postAiStatus('error', 'Could not revert the changes.', 'review');
      return;
    }
    try {
      await doc.save();
    } catch {
      /* the revert is applied in memory even if the save fails */
    }
    this.clearSnapshot();
    await this.postUpdate(doc);
    this.postAiStatus('done', 'Reverted to the original — undo (Cmd/Ctrl+Z) to restore.', 'idle');
  }

  // -- html shell ------------------------------------------------------------

  private buildHtml(): string {
    const webview = this.panel.webview;
    const nonce = getNonce();
    const doc = this.liveDocument();
    const initialHtml = doc ? renderDocumentHtml(doc.getText()) : '';
    this.renderedVersion = doc ? doc.version : -1;

    const mediaUri = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));

    const { fontSize, maxWidth, colorTheme } = getViewerConfig();
    const themeClass = THEME_CLASS[colorTheme];
    const maxWidthCss = maxWidth > 0 ? `${maxWidth}px` : 'none';

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${mediaUri('preview.css')}" />
  <link rel="stylesheet" href="${mediaUri('viewer.css')}" />
  <style nonce="${nonce}">:root{--mdc-font-size:${fontSize}px;--mdc-content-max-width:${maxWidthCss};}</style>
  <title>Markdown Comments</title>
</head>
<body class="${themeClass}" data-doc-version="${this.renderedVersion}">
  <div class="mdc-toolbar">
    <button type="button" id="mdc-remove-resolved" class="mdc-search-btn mdc-remove-resolved"
      title="Remove all resolved comments" hidden>Remove resolved</button>
    <button type="button" id="mdc-search-toggle" class="mdc-search-btn mdc-search-toggle"
      title="Search (⌘/Ctrl+F)" aria-label="Search" aria-expanded="false">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M11.74 10.68a6 6 0 1 0-1.06 1.06l3.3 3.3a.75.75 0 0 0 1.06-1.06l-3.3-3.3ZM2.5 6.75a4.25 4.25 0 1 1 8.5 0 4.25 4.25 0 0 1-8.5 0Z"/></svg>
    </button>
    <div class="mdc-search" role="search" hidden>
      <input id="mdc-search-input" class="mdc-search-input" type="text"
        placeholder="Search…" aria-label="Search" />
      <span id="mdc-search-count" class="mdc-search-count" aria-live="polite"></span>
      <button type="button" id="mdc-search-prev" class="mdc-search-btn"
        title="Previous match (Shift+Enter)" aria-label="Previous match">▲</button>
      <button type="button" id="mdc-search-next" class="mdc-search-btn"
        title="Next match (Enter)" aria-label="Next match">▼</button>
      <button type="button" id="mdc-search-clear" class="mdc-search-btn mdc-search-clear"
        title="Close search (Esc)" aria-label="Close search">×</button>
    </div>
  </div>
  <div id="mdc-content" class="mdc-content">${initialHtml}</div>
  <div id="mdc-toast" class="mdc-toast" role="status" aria-live="polite" hidden></div>
  <script nonce="${nonce}" src="${mediaUri('viewer.js')}"></script>
</body>
</html>`;
  }
}

function pathBasename(uri: vscode.Uri): string {
  const parts = uri.path.split('/');
  return parts[parts.length - 1] || uri.path;
}

/** The open text-editor tab for `uri`, restricted to `column` when given. */
function findTextTab(
  uri: vscode.Uri,
  column?: vscode.ViewColumn
): vscode.Tab | undefined {
  const target = uri.toString();
  for (const group of vscode.window.tabGroups.all) {
    if (column !== undefined && group.viewColumn !== column) {
      continue;
    }
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputText && input.uri.toString() === target) {
        return tab;
      }
    }
  }
  return undefined;
}

/** Whether a path points at a Markdown file (so it gets the comments view). */
function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext)$/i.test(p);
}
