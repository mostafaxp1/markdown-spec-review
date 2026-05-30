/**
 * Shared rendering of a parsed comment into the `<aside class="mdc-comment">`
 * bubble markup. Used by BOTH the built-in Markdown preview (via
 * markdownItComments.ts) and the interactive webview (via webviewRenderer.ts),
 * so the bubble looks identical in either surface.
 *
 * When `opts.interactive` is omitted/false the output is byte-identical to the
 * markup the built-in preview has always produced — the preview must not
 * regress. When `opts.interactive` is true the bubble additionally carries:
 *   - data-comment-index: the comment's document-order index (the stable key
 *     the webview echoes back so the host can locate it for edit/remove);
 *   - data-comment-author / data-comment-date / data-comment-body: the *raw*
 *     field values, so the webview can prefill the edit popup and send an
 *     `orig` fingerprint without re-parsing rendered HTML;
 *   - inline Edit/Delete action buttons.
 */

import type MarkdownIt from 'markdown-it';
import { ParsedComment, isResolvedBody } from './commentFormat';

export interface RenderBubbleOptions {
  /** Render interactive affordances (edit/delete + data-* hooks). */
  interactive?: boolean;
  /** Document-order index of this comment; required when interactive. */
  commentIndex?: number;
}

const COMMENT_ICON =
  '<svg class="mdc-comment-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path fill="currentColor" d="M1 2.75A1.75 1.75 0 0 1 2.75 1h10.5A1.75 1.75 0 0 1 15 2.75v7.5A1.75 1.75 0 0 1 13.25 12H7.06l-3.22 3.22A.75.75 0 0 1 2.5 14.69V12h-.25A1.75 1.75 0 0 1 1 10.25v-7.5Z"/>' +
  '</svg>';

function escapeHtml(md: MarkdownIt, text: string): string {
  return md.utils.escapeHtml(text);
}

/** Escape a value for safe use inside a double-quoted HTML attribute. */
function escapeAttr(md: MarkdownIt, text: string): string {
  // md.utils.escapeHtml already encodes & < > and ", which is sufficient for a
  // double-quoted attribute. Newlines are preserved verbatim by the HTML parser
  // and read back intact via element.dataset, so the body's line breaks survive.
  return md.utils.escapeHtml(text);
}

export function renderCommentBubble(
  md: MarkdownIt,
  c: ParsedComment,
  opts: RenderBubbleOptions = {}
): string {
  // Render inline markdown (bold/italic/code/links) per line, preserving the
  // author's line breaks. renderInline keeps this to inline-level output so we
  // don't get stray <p> wrappers inside the bubble.
  const bodyHtml = c.body
    .split('\n')
    .map((line) => md.renderInline(line))
    .join('<br>');

  const metaParts: string[] = [];
  if (c.author) {
    metaParts.push(`<span class="mdc-comment-author">${escapeHtml(md, c.author)}</span>`);
  }
  if (c.date) {
    metaParts.push(`<span class="mdc-comment-date">${escapeHtml(md, c.date)}</span>`);
  }
  const meta = metaParts.length
    ? `<div class="mdc-comment-meta">${metaParts.join(' · ')}</div>`
    : '';

  if (!opts.interactive) {
    return (
      '<aside class="mdc-comment" tabindex="0">' +
      `<div class="mdc-comment-head">${COMMENT_ICON}${meta}</div>` +
      `<div class="mdc-comment-body">${bodyHtml}</div>` +
      '</aside>'
    );
  }

  const idx = opts.commentIndex ?? 0;
  const resolved = isResolvedBody(c.body);
  const dataAttrs =
    ` data-comment-index="${idx}"` +
    ` data-comment-author="${escapeAttr(md, c.author ?? '')}"` +
    ` data-comment-date="${escapeAttr(md, c.date ?? '')}"` +
    ` data-comment-body="${escapeAttr(md, c.body)}"` +
    (resolved ? ' data-comment-resolved="1"' : '');

  // A small pill in the head flags a resolved comment, alongside the whole
  // bubble's `mdc-resolved` highlight; the webview reads the class to drive the
  // "Remove resolved" control.
  const resolvedBadge = resolved
    ? '<span class="mdc-resolved-badge" title="This comment has been resolved">✓ Resolved</span>'
    : '';

  const actions =
    '<div class="mdc-comment-actions">' +
    '<button type="button" class="mdc-action mdc-action-edit" aria-label="Edit comment" title="Edit comment">Edit</button>' +
    '<button type="button" class="mdc-action mdc-action-delete" aria-label="Delete comment" title="Delete comment">Delete</button>' +
    '</div>';

  const classes = 'mdc-comment mdc-interactive' + (resolved ? ' mdc-resolved' : '');

  return (
    `<aside class="${classes}" tabindex="0"${dataAttrs}>` +
    `<div class="mdc-comment-head">${COMMENT_ICON}${meta}${resolvedBadge}${actions}</div>` +
    `<div class="mdc-comment-body">${bodyHtml}</div>` +
    '</aside>'
  );
}
