# Markdown Spec Review

Markdown Spec Review is a VS Code extension for leaving review comments on
Markdown specs and documents. Comments are stored **inline** as HTML comment blocks, so
they travel with the file, stay diff-friendly, and remain invisible in other
Markdown renderers such as GitHub and npm.

The extension gives you two review surfaces:

- VS Code's built-in Markdown preview, where comments render as read-only
  bubbles.
- An Interactive Comments View, where you can add, edit, remove, search, and
  address comments directly from the rendered document.

## How it works

There are two ways to view and work with comments:

1. **The built-in Markdown preview** (read-only). The extension extends VS
   Code's built-in preview via a `markdown-it` plugin, so each comment renders
   as a bubble right after the block it annotates. Open it with
   `Cmd/Ctrl+Shift+V` and click a bubble's header to collapse/expand it.
   Authoring from here isn't possible — the built-in preview gives extensions
   no way to write back — so you add/edit/remove from the editor (see
   **Commands**).
2. **The Interactive Comments View** (read **and** write). Run **Open
   Interactive Comments View** (`Alt+Shift+V`, or the speech-bubble
   button in the editor toolbar) to swap the Markdown editor for a view where
   you author comments by clicking. The view opens **in place** — it takes over
   the same tab. `Alt+Shift+V` toggles: press it in the Markdown editor to open
   the view, press it again in the view to flip back to the raw `.md`. The
   **`</>` Show Markdown Source** button in its toolbar does the same flip back.
   - **Hover** any heading / paragraph / list item and click the floating
     **+** to add a comment via a popup.
   - **Mention files** while writing a comment — type **`@`** in the comment
     popup to find and reference workspace files. A suggestion list filters as
     you type; use **↑/↓** to move, **Enter** / **Tab** to insert the selected
     file path, and **Esc** to dismiss.
   - **Hover** any block and click the floating **✎ (Edit this block)** button
     to edit that block's raw Markdown source inline, with live syntax
     highlighting. **`⌘/Ctrl+Enter`** saves, **Esc** discards.
   - **Hover** an existing bubble and use its **Edit** / **Delete** controls
     (Delete asks for a quick confirm).
   - Every change is written straight back into the `.md` as an inline comment
     block and is fully **undoable** (`Cmd/Ctrl+Z`). By default the file is
     also saved after comment edits; turn off `markdownSpecReview.autoSave` if you
     prefer to keep the document dirty until you save manually. The view stays
     in sync if you also edit the file in the editor.
   - **Address comments** with an AI coding agent from the bar in the
     bottom-right — see [Address comments with AI](#address-comments-with-ai).
   - **Resolved comments** (any whose body has a `Resolved:` line — the marker
     the AI appends, or one you type yourself) are tinted green with a
     **✓ Resolved** badge. When any exist, a **Remove resolved** button appears
     in the floating control cluster at the **top-right** to sweep them all in
     one undoable edit (it asks for a quick confirm first).
   - **Find in comments** — there's no top bar; a small **🔍** button floats at
     the top-right (or press **⌘/Ctrl+F**) to open a find widget. Type to
     highlight matches, **Enter** / **Shift+Enter** to step through them, and
     **×** or **Esc** to close.

## Address comments with AI

From the **Interactive Comments View**, the floating **Address comments** bar
(bottom-right, shown whenever the document has comments) hands the whole file
and its review comments to a terminal coding agent and asks it to revise the
prose so each comment is addressed. The agent **keeps** every comment and
appends a `Resolved: …` line to its body, so you get an audit trail rather than
silent edits.

- Choose the **agent** and **run mode** in Settings; choose the **model** and
  **effort** right in the bar. The model dropdown is detected from the installed
  agent and always offers an _Agent default_.
- **Run mode** is either an integrated **terminal** (you watch the agent work
  and approve its edits) or **headless** (it runs in the background, edits the
  file, and the view refreshes when it finishes — progress is logged to the
  _Markdown Spec Review AI_ output channel).
- Supported agents: **Claude Code** (`claude`), **Codex** (`codex`),
  **GitHub Copilot CLI** (`copilot`), and **Antigravity** (`antigravity`). The
  chosen agent's CLI must be installed and on your `PATH`, or pointed at via
  `markdownSpecReview.ai.commands`.

While a run is in flight the bar shows a **Stop** button — it terminates the
headless process (or closes the run's terminal). Whatever the agent had already
written is kept for review, not discarded.

Once the agent finishes (or you Stop it) and the file changed, the bar switches
to a review step:

- **Review changes** opens a side-by-side diff of the original (left, read-only)
  against the revised file (right), so you can see exactly what the agent did.
- **Approve** keeps the changes and clears the review.
- **Revert** restores the original via a single undoable edit (`Cmd/Ctrl+Z`
  brings the agent's version back).

The same action is on the command palette as **Address Comments with AI** while
the Comments view is focused. The file must be saved to disk first — the agent
reads and writes it there.

## Commands

| Command                                                  | Default keybinding | What it does                                                                       |
| -------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| **Markdown Spec Review: Add Comment**                    | `Cmd/Ctrl+Alt+M`   | Insert a comment anchored to the current block                                     |
| **Markdown Spec Review: Edit Comment at Cursor**         | —                  | Edit the body of the comment under the cursor                                      |
| **Markdown Spec Review: Remove Comment at Cursor**       | —                  | Delete the comment under the cursor                                                |
| **Markdown Spec Review: Open Interactive Comments View** | `Alt+Shift+V`      | Open the click-to-comment view in place of the editor (add/edit/remove via popups) |
| **Markdown Spec Review: Show Markdown Source**           | `Alt+Shift+V`      | From the Comments view, flip back to the raw `.md` editor (same key toggles back)  |
| **Markdown Spec Review: Address Comments with AI**       | —                  | Hand the document's comments to the configured AI agent to resolve (Comments view) |

The first three are also on the editor right-click menu in Markdown files; the
interactive view is also available from the editor toolbar button, and the
Comments view's toolbar has a **Show Markdown Source** button to flip back.

## The inline format

A comment is one HTML comment block:

```markdown
## Project goals

<!-- mdc:comment
author: Mostafa
date: 2026-05-29

This section needs a measurable success metric.
-->
```

- `author` / `date` headers are optional and configurable.
- Everything after the blank line is the comment body.
- The block is plain text, diff-friendly, and ignored by other renderers.

## Settings

| Setting                                    | Default         | Description                                                                        |
| ------------------------------------------ | --------------- | ---------------------------------------------------------------------------------- |
| `markdownSpecReview.author`                | `""`            | Name attached to new comments (falls back to your OS username).                    |
| `markdownSpecReview.dateFormat`            | `"date"`        | `date`, `datetime`, or `none`.                                                     |
| `markdownSpecReview.autoSave`              | `true`          | Save the Markdown file after adding, editing, or removing a comment.               |
| `markdownSpecReview.openInViewerByDefault` | `false`         | Automatically open Markdown files in the Interactive Comments View.                |
| `markdownSpecReview.viewer.fontSize`       | `15`            | Font size, in pixels, for the Interactive Comments View.                           |
| `markdownSpecReview.viewer.maxWidth`       | `1100`          | Maximum content width in the Interactive Comments View; use `0` for full width.    |
| `markdownSpecReview.viewer.colorTheme`     | `"vscode"`      | Viewer theme: `vscode`, `light`, `dark`, `light-modern`, or `dark-modern`.         |
| `markdownSpecReview.ai.agent`              | `"claude-code"` | Agent for **Address comments**: `claude-code`, `codex`, `copilot`, `antigravity`.  |
| `markdownSpecReview.ai.runMode`            | `"terminal"`    | Run the agent in a `terminal` (watch & approve) or `headless` (auto-apply).        |
| `markdownSpecReview.ai.model`              | `""`            | Default model (empty = the agent's own default; also pickable per run in the bar). |
| `markdownSpecReview.ai.effort`             | `"medium"`      | Reasoning effort: `low`, `medium`, or `high`.                                      |
| `markdownSpecReview.ai.commands`           | `{}`            | Per-agent executable overrides, e.g. `{ "claude-code": "/usr/local/bin/claude" }`. |

## Develop

```bash
npm install
npm run compile     # or: npm run watch
```

Then press **F5** ("Run Extension") to launch an Extension Development Host with
`example.md` open. Open its preview to see the comment bubbles.

To build and install a local VSIX:

```bash
npm run rebuild
```

That command compiles the extension, packages it with `vsce`, and installs the
generated `.vsix` into VS Code.

## Known limitations

- The **built-in** Markdown preview stays read-only — it gives extensions no
  channel to write back, so click-to-comment lives in the separate
  **Interactive Comments View** (a custom webview) instead. Use whichever you
  prefer; comments are the same inline blocks in both.
- The interactive view renders relative image paths only when the file lives on
  disk, and authoring is disabled for never-saved (untitled) documents once
  they're closed.
