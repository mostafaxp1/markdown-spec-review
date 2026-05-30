# Markdown Spec Review — Demo

Open the preview (`Cmd/Ctrl+Shift+V`) to see comments rendered as bubbles.
Put your cursor in any heading or paragraph below and run **Add Comment**
(`Cmd/Ctrl+Alt+M`) to make your own.

## Project goals

sdsd

Success is measurable: at least 60% of active users add a comment within
their first week, and the preview renders comment bubbles in under 100 ms.

<!-- mdc:comment
author: mostafa
date: 2026-05-30

sdsad dsds
Resolved: Replaced the vague note with a concrete, measurable success metric.
-->

We want to ship a delightful product that users love — concretely, a tool that
earns a 4.5★ average rating and keeps 40% of commenters active week over week.
Delight, for us, means comments feel native to Markdown: they are easy to add
with a single shortcut, render inline as unobtrusive bubbles in the preview, and
never interfere with the underlying document or its version history. We measure
progress against this goal through the rating and retention figures above, plus
qualitative feedback gathered from early adopters each release.

<!-- mdc:comment
author: mostafa
date: 2026-05-30

expand
Resolved: Expanded the paragraph to describe what "delightful" means concretely and how we measure it.
-->

<!-- mdc:comment
author: mostafa
date: 2026-05-30

dfdfsdf
Resolved: Turned the aspirational goal into a specific, testable target.
-->

<!-- mdc:comment
author: mostafa
date: 2026-05-30

ssdd
Resolved: Tied the same goal to a measurable retention figure for the block above.
-->

## Architecture

The system has three layers: ingestion, processing, and presentation. Caching
sits between processing and presentation as an in-memory LRU cache, so repeated
requests return rendered results without re-running the processing layer.

<!-- mdc:comment
author: Reviewer
date: 2026-05-29

Where does caching live? Worth a sentence here.
Resolved: Added a sentence locating caching between processing and presentation.
-->

## Open questions

Nothing stored here yet — try adding your first comment to this paragraph.
