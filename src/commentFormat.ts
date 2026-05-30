/**
 * Shared definition of the inline comment format.
 *
 * A comment is stored as a single HTML comment block so that it is invisible
 * in every other Markdown renderer (GitHub, etc.) and travels with the file:
 *
 *   <!-- mdc:comment
 *   author: Mostafa Elkady
 *   date: 2026-05-29
 *
 *   The body of the comment, which may span
 *   multiple lines.
 *   -->
 *
 * The first line after `<!--` must be the SENTINEL. `key: value` header lines
 * follow until the first blank line; everything after that blank line is the
 * body. This module is the single source of truth for both the markdown-it
 * render plugin and the authoring commands.
 */

export const SENTINEL = 'mdc:comment';

/** Matches a whole comment block anywhere in a document (non-greedy). */
export const COMMENT_BLOCK_RE = /<!--\s*mdc:comment[\s\S]*?-->/g;

export interface ParsedComment {
  author?: string;
  date?: string;
  /** Any header keys we don't model explicitly are preserved here. */
  extra: Record<string, string>;
  body: string;
}

/**
 * Parse the *inner* text of an HTML comment (without the `<!--`/`-->`
 * delimiters) into a ParsedComment, or return null if it is not one of ours.
 */
export function parseComment(inner: string): ParsedComment | null {
  const trimmed = inner.trim();
  const firstBreak = trimmed.indexOf('\n');
  const firstLine = (firstBreak === -1 ? trimmed : trimmed.slice(0, firstBreak)).trim();
  if (firstLine !== SENTINEL) {
    return null;
  }

  const rest = firstBreak === -1 ? '' : trimmed.slice(firstBreak + 1);
  const lines = rest.split('\n');

  const result: ParsedComment = { extra: {}, body: '' };
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      i++; // consume the blank separator line
      break;
    }
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      // Not a header line — treat the remainder (this line included) as body.
      break;
    }
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === 'author') {
      result.author = value;
    } else if (key === 'date') {
      result.date = value;
    } else {
      result.extra[key] = value;
    }
  }

  result.body = lines.slice(i).join('\n').trim();
  return result;
}

/**
 * Whether a comment body carries a "Resolved:" marker line. This is the line an
 * agent appends to a comment after addressing it (see the "Address comments"
 * flow), and it is also what a user can type by hand to mark a comment done.
 * Matched case-insensitively at the start of any line, tolerating leading
 * blockquote / emphasis markers (e.g. `> **Resolved:** fixed`).
 */
export function isResolvedBody(body: string): boolean {
  return /^[\s>*_~-]*resolved\s*:/im.test(body);
}

export interface SerializeInput {
  author?: string;
  date?: string;
  body: string;
}

/** Build a full inline comment block (including delimiters) from fields. */
export function serializeComment(input: SerializeInput): string {
  // The body must never contain the comment terminator, or it would close the
  // HTML comment early and corrupt the document. Break the sequence with a
  // zero-width space so it reads identically but no longer terminates.
  const safeBody = input.body.replace(/-->/g, '--​>').trim();

  const header: string[] = [SENTINEL];
  if (input.author) {
    header.push(`author: ${input.author}`);
  }
  if (input.date) {
    header.push(`date: ${input.date}`);
  }

  return `<!-- ${header.join('\n')}\n\n${safeBody}\n-->`;
}
