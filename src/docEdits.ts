/**
 * Shared, framework-light document-editing/anchoring logic used by BOTH the
 * editor commands (commands.ts) and the interactive webview (viewerPanel.ts).
 *
 * Centralizing it means an inline comment is inserted, located, edited and
 * removed by exactly one implementation regardless of which surface the user
 * acted from — no behavioral drift between "author from the editor" and
 * "author from the view".
 *
 * All parsing/serialization is delegated to commentFormat.ts (the single source
 * of truth for the on-disk format).
 */

import * as vscode from 'vscode';
import * as os from 'os';
import {
  COMMENT_BLOCK_RE,
  parseComment,
  serializeComment,
  isResolvedBody,
  ParsedComment,
} from './commentFormat';

export interface FoundComment {
  range: vscode.Range;
  parsed: ParsedComment;
}

/** A minimal fingerprint of a comment, used as a fallback locator. */
export interface CommentFingerprint {
  author?: string;
  date?: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Config-derived defaults for new comments (shared so the editor and the view
// stamp identical author/date values).
// ---------------------------------------------------------------------------

export function getAuthor(): string {
  const configured = vscode.workspace
    .getConfiguration('markdownComments')
    .get<string>('author', '')
    .trim();
  if (configured) {
    return configured;
  }
  try {
    return os.userInfo().username || 'Unknown';
  } catch {
    return 'Unknown';
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function getDate(): string {
  const format = vscode.workspace
    .getConfiguration('markdownComments')
    .get<string>('dateFormat', 'date');
  if (format === 'none') {
    return '';
  }
  const d = new Date();
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (format === 'datetime') {
    return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return date;
}

/**
 * Persist the document after a comment add/edit/remove when the `autoSave`
 * setting is on (the default). Shared by the editor commands and the
 * interactive view so both surfaces save the same way.
 *
 * Untitled buffers are skipped — saving one would pop a "Save As" dialog — and
 * clean documents need no save. A failed save is swallowed: the edit is already
 * applied in memory, so the worst case is the file is left dirty as before.
 */
export async function maybeAutoSaveComment(doc: vscode.TextDocument): Promise<void> {
  if (doc.uri.scheme === 'untitled' || !doc.isDirty) {
    return;
  }
  const enabled = vscode.workspace
    .getConfiguration('markdownComments')
    .get<boolean>('autoSave', true);
  if (!enabled) {
    return;
  }
  try {
    await doc.save();
  } catch {
    /* non-fatal — the edit is applied in memory even if the save fails */
  }
}

// ---------------------------------------------------------------------------
// Anchoring
// ---------------------------------------------------------------------------

/**
 * Last line (0-based) of the block that begins at `line`: walk forward while
 * the next line is non-blank. A new comment inserted at the end of this line
 * anchors to the cursor's / clicked block.
 */
export function endOfBlockLine(document: vscode.TextDocument, line: number): number {
  let end = line;
  while (end + 1 < document.lineCount && document.lineAt(end + 1).text.trim() !== '') {
    end++;
  }
  return end;
}

/**
 * Compute where to insert a freshly built comment block so it anchors to the
 * block whose last content line begins at/within `anchorStartLine`.
 *
 * `anchorStartLine` is a 0-based line *inside* the target block (the editor
 * passes the cursor line; the webview passes the block's last content line —
 * derived from token.map's exclusive end minus one). The returned text carries
 * the blank-line separator the renderer expects before a bubble.
 */
export function computeInsert(
  document: vscode.TextDocument,
  anchorStartLine: number,
  block: string
): { position: vscode.Position; text: string } {
  const safeLine = Math.max(0, Math.min(anchorStartLine, document.lineCount - 1));
  const anchor = endOfBlockLine(document, safeLine);
  const position = document.lineAt(anchor).range.end;
  return { position, text: `\n\n${block}` };
}

/** Build a brand-new comment block, stamping configured author/date defaults. */
export function buildNewBlock(body: string): string {
  return serializeComment({ author: getAuthor(), date: getDate(), body });
}

/** Re-serialize an edited comment, preserving its original author/date. */
export function buildEditedBlock(orig: ParsedComment, body: string): string {
  return serializeComment({ author: orig.author, date: orig.date, body });
}

// ---------------------------------------------------------------------------
// Locating existing comments
// ---------------------------------------------------------------------------

function rangeOfMatch(
  document: vscode.TextDocument,
  match: RegExpExecArray
): vscode.Range {
  const start = match.index;
  const end = start + match[0].length;
  return new vscode.Range(document.positionAt(start), document.positionAt(end));
}

function parseMatch(match: RegExpExecArray): ParsedComment | null {
  const inner = match[0].replace(/^<!--/, '').replace(/-->$/, '');
  return parseComment(inner);
}

/**
 * Find the comment block whose text range contains `position`, if any.
 * (Cursor-driven locator used by the editor commands.)
 */
export function findCommentAt(
  document: vscode.TextDocument,
  position: vscode.Position
): FoundComment | null {
  const text = document.getText();
  const offset = document.offsetAt(position);
  COMMENT_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = COMMENT_BLOCK_RE.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (offset >= start && offset <= end) {
      const parsed = parseMatch(match);
      if (parsed) {
        return { range: rangeOfMatch(document, match), parsed };
      }
    }
  }
  return null;
}

/**
 * Find the Nth valid comment block in document order (0-based). This is the
 * stable key the webview echoes back: it agrees with webviewRenderer's
 * commentIndex because both enumerate comments forward through the document and
 * count only blocks that parseComment accepts.
 */
export function findCommentByIndex(
  document: vscode.TextDocument,
  index: number
): FoundComment | null {
  const text = document.getText();
  COMMENT_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = COMMENT_BLOCK_RE.exec(text)) !== null) {
    const parsed = parseMatch(match);
    if (!parsed) {
      continue;
    }
    if (i === index) {
      return { range: rangeOfMatch(document, match), parsed };
    }
    i++;
  }
  return null;
}

/**
 * Document-order index (0-based) the next comment at/after `offset` would have:
 * the count of valid comments whose block starts strictly before `offset`.
 * Used to focus a freshly inserted comment after re-render.
 */
export function commentIndexAtOffset(document: vscode.TextDocument, offset: number): number {
  const text = document.getText();
  COMMENT_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = COMMENT_BLOCK_RE.exec(text)) !== null) {
    if (!parseMatch(match)) {
      continue;
    }
    if (match.index >= offset) {
      break;
    }
    i++;
  }
  return i;
}

/**
 * Fallback locator: find the comment whose author/date/body match `fp`.
 * Used when an index lookup is suspect (e.g. a near-simultaneous external edit)
 * to avoid editing the wrong block. Returns null if no — or more than one —
 * comment matches (ambiguous => caller should abort).
 */
export function findCommentByContent(
  document: vscode.TextDocument,
  fp: CommentFingerprint
): FoundComment | null {
  const text = document.getText();
  COMMENT_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let found: FoundComment | null = null;
  while ((match = COMMENT_BLOCK_RE.exec(text)) !== null) {
    const parsed = parseMatch(match);
    if (!parsed) {
      continue;
    }
    if (
      (parsed.author ?? '') === (fp.author ?? '') &&
      (parsed.date ?? '') === (fp.date ?? '') &&
      parsed.body === fp.body
    ) {
      if (found) {
        return null; // ambiguous
      }
      found = { range: rangeOfMatch(document, match), parsed };
    }
  }
  return found;
}

/**
 * Every resolved comment in the document, in document order. A comment is
 * resolved when its body carries a "Resolved:" marker line (see isResolvedBody).
 * Used by the "Remove resolved" bulk action in the interactive view.
 */
export function findResolvedComments(document: vscode.TextDocument): FoundComment[] {
  const text = document.getText();
  COMMENT_BLOCK_RE.lastIndex = 0;
  const out: FoundComment[] = [];
  let match: RegExpExecArray | null;
  while ((match = COMMENT_BLOCK_RE.exec(text)) !== null) {
    const parsed = parseMatch(match);
    if (parsed && isResolvedBody(parsed.body)) {
      out.push({ range: rangeOfMatch(document, match), parsed });
    }
  }
  return out;
}

/** True when a found comment matches the supplied fingerprint. */
export function matchesFingerprint(parsed: ParsedComment, fp: CommentFingerprint): boolean {
  return (
    (parsed.author ?? '') === (fp.author ?? '') &&
    (parsed.date ?? '') === (fp.date ?? '') &&
    parsed.body === fp.body
  );
}

/**
 * Expand a comment's range leftward to also swallow up to two leading newline
 * separators (the blank line we insert before each comment), so removing a
 * comment doesn't leave a double blank line behind.
 */
export function computeRemoveRange(
  document: vscode.TextDocument,
  commentRange: vscode.Range
): vscode.Range {
  const text = document.getText();
  let delStart = document.offsetAt(commentRange.start);
  let swallowed = 0;
  while (delStart > 0 && text[delStart - 1] === '\n' && swallowed < 2) {
    delStart--;
    swallowed++;
  }
  return new vscode.Range(document.positionAt(delStart), commentRange.end);
}
