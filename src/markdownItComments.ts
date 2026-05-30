import type MarkdownIt from 'markdown-it';
import { parseComment } from './commentFormat';
import { renderCommentBubble } from './commentRender';

/** Signature of a markdown-it renderer rule (kept local to avoid depending on
 *  the package's internal type subpaths, which differ across versions). */
type RenderRule = (
  tokens: any[],
  idx: number,
  options: any,
  env: any,
  self: any
) => string;

/** Pull the inner text out of a raw `<!-- ... -->` string, or null. */
export function extractInner(raw: string): string | null {
  const match = /^\s*<!--([\s\S]*?)-->\s*$/.exec(raw);
  return match ? match[1] : null;
}

export interface CommentPluginOptions {
  /**
   * Render interactive bubbles (edit/delete controls + data-* hooks). The
   * document-order index threaded onto each bubble is read from
   * `token.meta.mdcIndex`, which the webview renderer's core rule assigns.
   * Defaults to false, so the built-in preview gets the read-only bubble it
   * has always shown (byte-identical output).
   */
  interactive?: boolean;
}

/**
 * markdown-it plugin: intercept HTML comment tokens that match our format and
 * render them as styled comment bubbles. Everything else falls through to the
 * default renderer untouched.
 *
 * The bubble markup itself lives in commentRender.ts so the built-in preview
 * and the interactive webview render identical bubbles.
 */
export function commentPlugin(md: MarkdownIt, opts: CommentPluginOptions = {}): void {
  const patch = (ruleName: 'html_block' | 'html_inline') => {
    const fallback: RenderRule =
      md.renderer.rules[ruleName] ?? ((tokens, idx) => tokens[idx].content);

    md.renderer.rules[ruleName] = (tokens, idx, options, env, self) => {
      const inner = extractInner(tokens[idx].content);
      if (inner !== null) {
        const parsed = parseComment(inner);
        if (parsed) {
          if (opts.interactive) {
            const commentIndex = tokens[idx].meta?.mdcIndex ?? 0;
            return renderCommentBubble(md, parsed, { interactive: true, commentIndex });
          }
          return renderCommentBubble(md, parsed);
        }
      }
      return fallback(tokens, idx, options, env, self);
    };
  };

  patch('html_block');
  patch('html_inline');
}
