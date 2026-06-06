# Changelog

All notable changes to the Markdown Spec Review extension are documented here.

## [0.2.0]

### Added
- Open the Interactive Comments View directly from the **Explorer** and **editor-tab** context menus for any Markdown file — not just the active editor.
- Right-click in the page margins (outside the rendered document) now opens the block menu, targeting the last hovered block or the block nearest the top of the viewport.
- The Markdown source editor now highlights the block being edited, with its own distinct flat-green tint so it reads differently from the comment target highlight.

### Changed
- Hovering another block while a popup is open now retargets it instead of being blocked — the comment editor and source editor auto-close (comment drafts are preserved) before acting on the new block.
- Comment styling in the preview is now flatter and more neutral: a subtle gray left accent and faint fill instead of the theme's link-blue, so comments read as quiet annotations.
- Refined hover-line behavior for lists: nested lists and loose-list paragraphs no longer draw duplicate lines, ordered-list markers get extra clearance, and parent blocks fade so the deepest hovered item reads as primary.
- Smaller, quieter add/edit affordance buttons and increased viewer side padding for a calmer layout.

## [0.1.0]

- Initial release.
