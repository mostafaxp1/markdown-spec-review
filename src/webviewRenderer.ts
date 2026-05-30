/**
 * Extension-host Markdown renderer for the interactive Comments view.
 *
 * Owns a single markdown-it instance (separate from the built-in preview's,
 * which VS Code controls) configured to:
 *   - render our comment bubbles INTERACTIVELY (edit/delete + data-comment-index),
 *   - stamp every block element with its source line range (data-source-line /
 *     data-source-end), so a click in the webview maps back to a position in
 *     the `.md` for inserting a new comment.
 *
 * Rendering on the host (rather than in the webview) lets us reuse
 * commentFormat.ts and commentRender.ts verbatim and keeps the webview script
 * tiny — it only presents HTML and relays events.
 */

import MarkdownIt from 'markdown-it';
import { parseComment } from './commentFormat';
import { commentPlugin, extractInner } from './markdownItComments';

/** Self-contained block tokens (nesting 0) that still carry a source map. */
const SELF_CONTAINED_BLOCKS = new Set(['fence', 'code_block', 'html_block', 'hr']);

let md: MarkdownIt | undefined;

function getMd(): MarkdownIt {
  if (md) {
    return md;
  }
  const instance = new MarkdownIt({ html: true, linkify: true });

  // Core rule: stamp source-line attributes on block elements, and assign a
  // stable document-order index to each of our comment tokens.
  //
  // The index counter walks tokens forward through the document and counts only
  // blocks that parseComment accepts — the SAME order and filter that
  // docEdits.findCommentByIndex uses — so an index rendered here resolves to the
  // same comment when the webview echoes it back for edit/remove.
  instance.core.ruler.push('mdcSourceMap', (state) => {
    let commentIndex = 0;
    const visit = (tokens: any[]): void => {
      for (const token of tokens) {
        if (
          Array.isArray(token.map) &&
          (token.nesting === 1 || SELF_CONTAINED_BLOCKS.has(token.type))
        ) {
          token.attrSet('data-source-line', String(token.map[0]));
          token.attrSet('data-source-end', String(token.map[1]));
        }
        if (token.type === 'html_block' || token.type === 'html_inline') {
          const inner = extractInner(token.content);
          if (inner !== null && parseComment(inner)) {
            token.meta = token.meta || {};
            token.meta.mdcIndex = commentIndex++;
          }
        }
        if (token.children) {
          visit(token.children);
        }
      }
    };
    visit(state.tokens);
  });

  instance.use(commentPlugin, { interactive: true });
  md = instance;
  return instance;
}

/** Render the full Markdown document to interactive HTML for the webview. */
export function renderDocumentHtml(text: string): string {
  return getMd().render(text);
}
