// Runs inside the interactive Comments webview (viewerPanel.ts).
//
// The webview is a thin presentation/event layer: the extension host renders
// the HTML and owns the document. This script only:
//   - shows a hover "+" affordance on each block so the user can add a comment,
//   - shows Edit/Delete controls on each comment bubble,
//   - drives the add/edit popup modal,
//   - relays add/edit/remove intents (with the document version it was rendered
//     against) back to the host, which validates and applies the edit,
//   - re-renders #mdc-content when the host posts a fresh 'update'.
//
// All user-supplied text is set via textContent / input.value — never innerHTML.
(function () {
  const vscode = acquireVsCodeApi();

  const content = document.getElementById('mdc-content');
  const emptyEl = document.getElementById('mdc-empty');
  const toastEl = document.getElementById('mdc-toast');

  let docVersion = Number(document.body.dataset.docVersion || -1);

  const prevState = vscode.getState() || {};
  let pendingScrollRestore =
    typeof prevState.scrollY === 'number' ? prevState.scrollY : null;

  // Drafts of in-progress comment text, keyed by target (block for add, comment
  // for edit). A draft is kept until the comment is saved or the user clears the
  // textarea themselves, so closing/cancelling the popup — or a re-render — never
  // throws away typing.
  let drafts =
    prevState.drafts && typeof prevState.drafts === 'object'
      ? prevState.drafts
      : {};

  // Flag every block (add draft) or comment bubble (edit draft) that currently
  // has stashed text, so a pencil badge surfaces in its left margin. Re-run
  // whenever drafts change or the content is re-rendered.
  function refreshDraftMarkers() {
    const marked = content.querySelectorAll('.mdc-has-draft');
    for (let i = 0; i < marked.length; i++) {
      marked[i].classList.remove('mdc-has-draft');
      if (marked[i].getAttribute('data-mdc-draft-title') === '1') {
        marked[i].removeAttribute('title');
        marked[i].removeAttribute('data-mdc-draft-title');
      }
    }
    Object.keys(drafts).forEach(function (key) {
      if (!drafts[key]) {
        return;
      }
      let el = null;
      if (key.indexOf('add:') === 0) {
        el = content.querySelector('[data-source-line="' + key.slice(4) + '"]');
      } else if (key.indexOf('edit:') === 0) {
        el = content.querySelector(
          '.mdc-comment[data-comment-index="' + key.slice(5) + '"]'
        );
      }
      if (el) {
        el.classList.add('mdc-has-draft');
        if (!el.hasAttribute('title')) {
          el.setAttribute('title', 'Unsaved comment draft');
          el.setAttribute('data-mdc-draft-title', '1');
        }
      }
    });
  }

  function draftKey(state) {
    if (!state) {
      return null;
    }
    if (state.mode === 'add') {
      return state.sourceLine != null ? 'add:' + state.sourceLine : 'add';
    }
    if (state.mode === 'edit') {
      return state.commentIndex != null ? 'edit:' + state.commentIndex : null;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Floating "add comment" affordance
  // ---------------------------------------------------------------------------
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'mdc-add-affordance';
  addBtn.title = 'Add a comment to this block';
  addBtn.setAttribute('aria-label', 'Add a comment to this block');
  addBtn.textContent = '+';
  addBtn.hidden = true;
  document.body.appendChild(addBtn);

  const editBlockBtn = document.createElement('button');
  editBlockBtn.type = 'button';
  editBlockBtn.className = 'mdc-add-affordance mdc-edit-block-affordance';
  editBlockBtn.title = 'Edit this block';
  editBlockBtn.setAttribute('aria-label', 'Edit this block');
  editBlockBtn.innerHTML =
    '<svg viewBox="0 0 16 16" width="9" height="9" aria-hidden="true">' +
    '<path fill="currentColor" d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/>' +
    '</svg>';
  editBlockBtn.hidden = true;
  document.body.appendChild(editBlockBtn);

  let hoverBlock = null;
  // The most recently hovered block, kept even after the hover clears (on scroll
  // or when the pointer leaves the document into the page margins) so a
  // right-click out there still has a block to act on.
  let lastHoverBlock = null;
  let hoveredEls = [];

  function clearHovered() {
    for (let i = 0; i < hoveredEls.length; i++) {
      hoveredEls[i].classList.remove('mdc-hovered');
    }
    hoveredEls = [];
  }

  function showAffordanceFor(block) {
    if (hoverBlock !== block) {
      clearHovered();
    }
    hoverBlock = block;
    lastHoverBlock = block;
    hoveredEls = [block];
    let el = block.parentElement;
    while (el && el !== content) {
      if (el.tagName === 'LI' || el.tagName === 'UL' || el.tagName === 'OL') {
        hoveredEls.push(el);
      }
      el = el.parentElement;
    }
    for (let i = 0; i < hoveredEls.length; i++) {
      hoveredEls[i].classList.add('mdc-hovered');
    }
    const rect = block.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const top = Math.max(2, rect.top);
    const left = Math.min(window.innerWidth - 70, Math.max(8, contentRect.right + 14));
    addBtn.style.top = top + 'px';
    addBtn.style.left = left + 'px';
    addBtn.hidden = false;
    editBlockBtn.style.top = top + 'px';
    editBlockBtn.style.left = (left + 28) + 'px';
    editBlockBtn.hidden = false;
  }

  function hideAffordance() {
    addBtn.hidden = true;
    editBlockBtn.hidden = true;
    clearHovered();
    hoverBlock = null;
  }

  function hideAffordanceButtons() {
    addBtn.hidden = true;
    editBlockBtn.hidden = true;
  }

  function restoreAffordance() {
    if (hoverBlock && content.contains(hoverBlock) && backdrop.hidden && mdEditBackdrop.hidden) {
      showAffordanceFor(hoverBlock);
    }
  }

  content.addEventListener('mouseover', function (e) {
    // Either popup (comment editor or markdown source editor) staying open is
    // fine: hovering another block lets the user retarget it — the affordance /
    // menu actions auto-close the current popup first.
    const target = e.target.closest && e.target.closest('[data-source-line]');
    if (target && content.contains(target)) {
      showAffordanceFor(target);
    }
  });

  window.addEventListener('scroll', hideAffordance, true);

  addBtn.addEventListener('click', function () {
    if (!hoverBlock) {
      return;
    }
    startAddForBlock(hoverBlock);
  });

  function startAddForBlock(block) {
    if (!block) {
      return;
    }
    // A popup may already be open (retargeting to a different paragraph or
    // switching action) — close it first. Any in-progress comment text is
    // stashed as a draft, so it isn't lost.
    if (!backdrop.hidden) {
      closeModal();
    }
    if (!mdEditBackdrop.hidden) {
      closeMdEditor();
    }
    const sourceEnd = Number(block.getAttribute('data-source-end'));
    const sourceLine = Number(block.getAttribute('data-source-line'));
    hideAffordanceButtons();
    openModal({ mode: 'add', sourceEnd: sourceEnd, sourceLine: sourceLine }, block);
  }

  function startEditForBlock(block) {
    if (!block) {
      return;
    }
    // Retargeting from an already-open popup — close it first. A comment draft
    // is preserved; unsaved markdown source edits are discarded (same as the
    // editor's Discard button).
    if (!backdrop.hidden) {
      closeModal();
    }
    if (!mdEditBackdrop.hidden) {
      closeMdEditor();
    }
    const sourceLine = Number(block.getAttribute('data-source-line'));
    const sourceEnd = Number(block.getAttribute('data-source-end'));
    hideAffordanceButtons();
    vscode.postMessage({ type: 'requestBlockMarkdown', sourceLine: sourceLine, sourceEnd: sourceEnd });
  }

  editBlockBtn.addEventListener('click', function () {
    if (!hoverBlock) {
      return;
    }
    startEditForBlock(hoverBlock);
  });

  // ---------------------------------------------------------------------------
  // Right-click context menu (Comment / Edit) for a block
  // ---------------------------------------------------------------------------
  const blockMenu = document.createElement('div');
  blockMenu.className = 'mdc-context-menu';
  blockMenu.setAttribute('role', 'menu');
  blockMenu.hidden = true;
  blockMenu.innerHTML =
    '<button type="button" class="mdc-context-item" role="menuitem" data-action="comment">Comment</button>' +
    '<button type="button" class="mdc-context-item" role="menuitem" data-action="edit">Edit</button>' +
    '<button type="button" class="mdc-context-item" role="menuitem" data-action="copy">Copy</button>';
  document.body.appendChild(blockMenu);

  let menuBlock = null;
  let menuSelection = '';

  function hideBlockMenu() {
    if (blockMenu.hidden) {
      return;
    }
    blockMenu.hidden = true;
    menuBlock = null;
  }

  function showBlockMenu(block, x, y) {
    menuBlock = block;
    blockMenu.hidden = false;
    // Clamp to the viewport so the menu never spills off-screen.
    const rect = blockMenu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 6);
    const top = Math.min(y, window.innerHeight - rect.height - 6);
    blockMenu.style.left = Math.max(6, left) + 'px';
    blockMenu.style.top = Math.max(6, top) + 'px';
  }

  content.addEventListener('contextmenu', function (e) {
    const block = e.target.closest && e.target.closest('[data-source-line]');
    if (!block || !content.contains(block)) {
      return;
    }
    e.preventDefault();
    hideAffordanceButtons();
    // Capture the selection now — clicking a menu item collapses it.
    const sel = window.getSelection();
    menuSelection = sel ? String(sel) : '';
    showBlockMenu(block, e.clientX, e.clientY);
  });

  // Right-click in the page margins (outside the rendered document) still opens
  // the menu, targeting the last hovered block — or, failing that, the block
  // nearest the top of the viewport.
  document.addEventListener('contextmenu', function (e) {
    if (content.contains(e.target)) {
      return; // handled by the content-level listener above
    }
    if (backdrop.contains(e.target) || mdEditBackdrop.contains(e.target)) {
      return; // right-click inside an open popup — leave it be
    }
    const block =
      lastHoverBlock && lastHoverBlock.isConnected ? lastHoverBlock : pickTargetBlock();
    if (!block) {
      return;
    }
    e.preventDefault();
    hideAffordanceButtons();
    const sel = window.getSelection();
    menuSelection = sel ? String(sel) : '';
    showBlockMenu(block, e.clientX, e.clientY);
  });

  blockMenu.addEventListener('click', function (e) {
    const item = e.target.closest && e.target.closest('.mdc-context-item');
    if (!item) {
      return;
    }
    const block = menuBlock;
    const action = item.getAttribute('data-action');
    hideBlockMenu();
    if (action === 'comment') {
      startAddForBlock(block);
    } else if (action === 'edit') {
      startEditForBlock(block);
    } else if (action === 'copy') {
      const text = menuSelection.trim();
      if (text) {
        vscode.postMessage({ type: 'copyText', text: menuSelection });
      } else {
        showToast('Select some text to copy first.');
      }
    }
  });

  // Dismiss the menu on any outside click, scroll, Escape, or new context menu.
  document.addEventListener('mousedown', function (e) {
    if (!blockMenu.hidden && !blockMenu.contains(e.target)) {
      hideBlockMenu();
    }
  });
  window.addEventListener('scroll', hideBlockMenu, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      hideBlockMenu();
    }
  });

  // "Add Comment" invoked from the command palette / keyboard shortcut (cmd or
  // ctrl+alt+m) while this view is focused — there's no hover or text cursor to
  // anchor it, so target the hovered block if any, else the one nearest the top
  // of the viewport (the block the user is looking at).
  function pickTargetBlock() {
    if (hoverBlock && hoverBlock.isConnected) {
      return hoverBlock;
    }
    const blocks = content.querySelectorAll('[data-source-line]');
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < blocks.length; i++) {
      const rect = blocks[i].getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) {
        continue; // out of view
      }
      const dist = Math.abs(rect.top - 60);
      if (dist < bestDist) {
        bestDist = dist;
        best = blocks[i];
      }
    }
    return best || (blocks.length ? blocks[0] : null);
  }

  function startAddFromCommand() {
    if (!backdrop.hidden) {
      return; // a popup is already open — leave the user's in-progress text
    }
    const block = pickTargetBlock();
    if (!block) {
      showToast('No heading or paragraph to comment on yet.');
      return;
    }
    startAddForBlock(block);
  }

  // ---------------------------------------------------------------------------
  // Hyperlinks
  // ---------------------------------------------------------------------------
  // A webview frame cannot navigate, so a bare <a> click does nothing useful —
  // relative file links especially are dead. We claim the click and relay the
  // raw href to the host, which decides between opening the browser, the
  // interactive comments view, or a new editor tab; in-page fragments scroll here.
  //
  // VS Code injects its OWN click handler into the webview that also acts on
  // <a> elements. preventDefault alone doesn't stop that separate handler — so
  // the listener below runs in the CAPTURE phase (before VS Code's) and this
  // function calls stopImmediatePropagation to keep the event from ever reaching
  // it. That's the piece that makes preventDefault actually take effect.
  function handleLinkClick(e, anchor) {
    // getAttribute keeps the author's ORIGINAL href; the .href property would be
    // resolved against the webview's vscode-webview:// base and be useless.
    const href = anchor.getAttribute('href');
    if (!href) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') {
      e.stopImmediatePropagation();
    }
    // In-page anchor: scroll within the view.
    if (href.charAt(0) === '#') {
      scrollToFragment(href.slice(1));
      return;
    }
    // Web URLs and relative / workspace file links alike: hand the raw href to
    // the host to open as the browser, the comments view, or a new editor tab.
    vscode.postMessage({ type: 'openLink', href: href });
  }

  // Capture phase + stopImmediatePropagation above = we run before VS Code's
  // built-in link handler and the click never reaches it. Attached to the
  // document so it covers content and comment bodies alike.
  document.addEventListener(
    'click',
    function (e) {
      const anchor = e.target.closest && e.target.closest('a[href]');
      if (anchor) {
        handleLinkClick(e, anchor);
      }
    },
    true
  );

  function scrollToFragment(rawId) {
    let id = rawId;
    try {
      id = decodeURIComponent(rawId);
    } catch (_) {
      /* keep the raw id if it isn't valid percent-encoding */
    }
    if (!id) {
      return;
    }
    const target = document.getElementById(id);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // ---------------------------------------------------------------------------
  // Bubble actions (edit / delete) + collapse toggle
  // ---------------------------------------------------------------------------
  content.addEventListener('click', function (e) {
    // Anchor clicks are handled in the capture-phase listener above (which stops
    // propagation), so they never reach here.
    const editBtn = e.target.closest && e.target.closest('.mdc-action-edit');
    if (editBtn) {
      const aside = editBtn.closest('.mdc-comment');
      if (aside) {
        openModal(
          {
            mode: 'edit',
            commentIndex: Number(aside.dataset.commentIndex),
            author: aside.dataset.commentAuthor || '',
            date: aside.dataset.commentDate || '',
            body: aside.dataset.commentBody || '',
          },
          aside
        );
      }
      return;
    }

    const delBtn = e.target.closest && e.target.closest('.mdc-action-delete');
    if (delBtn) {
      handleDelete(delBtn);
      return;
    }

    // Preserve the built-in preview behavior: clicking a bubble's header (but
    // not its action buttons) collapses/expands it.
    const head = e.target.closest && e.target.closest('.mdc-comment-head');
    if (head && !(e.target.closest && e.target.closest('.mdc-comment-actions'))) {
      const comment = head.closest('.mdc-comment');
      if (comment) {
        comment.classList.toggle('mdc-collapsed');
      }
    }
  });

  function handleDelete(delBtn) {
    const aside = delBtn.closest('.mdc-comment');
    if (!aside) {
      return;
    }
    if (delBtn.dataset.confirm === '1') {
      vscode.postMessage({
        type: 'removeComment',
        commentIndex: Number(aside.dataset.commentIndex),
        orig: {
          author: aside.dataset.commentAuthor || '',
          date: aside.dataset.commentDate || '',
          body: aside.dataset.commentBody || '',
        },
        docVersion: docVersion,
      });
      return;
    }
    delBtn.dataset.confirm = '1';
    delBtn.textContent = 'Confirm?';
    delBtn.classList.add('mdc-confirm');
    setTimeout(function () {
      if (delBtn.isConnected) {
        delBtn.dataset.confirm = '';
        delBtn.textContent = 'Delete';
        delBtn.classList.remove('mdc-confirm');
      }
    }, 3000);
  }

  // ---------------------------------------------------------------------------
  // Modal popup (add / edit)
  // ---------------------------------------------------------------------------
  const backdrop = document.createElement('div');
  backdrop.className = 'mdc-modal-backdrop';
  backdrop.hidden = true;
  // A non-modal dialog (aria-modal="false") docked at the bottom: the preview
  // above it stays live, so the dialog is laid out as a compact full-width bar.
  backdrop.innerHTML =
    '<div class="mdc-modal" role="dialog" aria-modal="false" aria-labelledby="mdc-modal-title">' +
    '<h2 id="mdc-modal-title" class="mdc-modal-title"></h2>' +
    '<div class="mdc-textarea-wrap">' +
    '<ul class="mdc-mention-list" hidden aria-label="File suggestions" role="listbox"></ul>' +
    '<textarea id="mdc-modal-textarea" class="mdc-modal-textarea" rows="8" ' +
    'placeholder="Type your comment… (@ to reference a file)" aria-label="Comment text"></textarea>' +
    '</div>' +
    '<div class="mdc-modal-foot">' +
    '<div class="mdc-modal-hint">Markdown supported · <kbd>Esc</kbd> to cancel · <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> to save</div>' +
    '<div class="mdc-modal-buttons">' +
    '<button type="button" class="mdc-modal-cancel">Cancel</button>' +
    '<button type="button" class="mdc-modal-save">Save</button>' +
    '</div>' +
    '</div>' +
    '</div>';
  document.body.appendChild(backdrop);

  const modalEl = backdrop.querySelector('.mdc-modal');
  const titleEl = backdrop.querySelector('.mdc-modal-title');
  const textarea = backdrop.querySelector('.mdc-modal-textarea');
  const mentionListEl = backdrop.querySelector('.mdc-mention-list');
  const cancelBtn = backdrop.querySelector('.mdc-modal-cancel');
  const saveBtn = backdrop.querySelector('.mdc-modal-save');

  let modalState = null;
  let lastFocused = null;

  // ---- target highlight ----------------------------------------------------
  // While the docked editor is open we mark the block being commented on (add)
  // or the comment bubble being edited (edit) so it's clear what the comment
  // belongs to, even though the preview above stays fully visible.
  let highlightedEl = null;
  let highlightClass = 'mdc-target';

  // The comment popup marks its target with 'mdc-target'; the markdown source
  // editor passes 'mdc-target-edit' for a simpler, differently-colored tint.
  function setHighlight(el, cls) {
    const klass = cls || 'mdc-target';
    if (highlightedEl === el && highlightClass === klass) {
      return;
    }
    clearHighlight();
    if (el && el.classList) {
      el.classList.add(klass);
      highlightedEl = el;
      highlightClass = klass;
    }
  }

  function clearHighlight() {
    if (highlightedEl && highlightedEl.classList) {
      highlightedEl.classList.remove(highlightClass);
    }
    highlightedEl = null;
  }

  // Re-find the popup's target from the (serializable) modal state — so the
  // highlight can be restored after a re-render or a reloaded view, where the
  // original element reference is gone.
  function resolveTargetEl(state) {
    if (!state) {
      return null;
    }
    if (state.mode === 'edit' && state.commentIndex != null) {
      return content.querySelector(
        '.mdc-comment[data-comment-index="' + state.commentIndex + '"]'
      );
    }
    if (state.mode === 'add' && state.sourceLine != null) {
      return content.querySelector('[data-source-line="' + state.sourceLine + '"]');
    }
    return null;
  }

  // Keep the highlighted target clear of the docked bar: if it sits behind the
  // bar (or above the top edge), nudge it into the visible band above the bar.
  function ensureTargetVisible(el) {
    if (!el) {
      return;
    }
    const rect = el.getBoundingClientRect();
    const barH = modalEl ? modalEl.getBoundingClientRect().height : 0;
    const top = 8;
    const bottom = window.innerHeight - barH - 8;
    if (rect.top < top || rect.bottom > bottom) {
      const elCenter = rect.top + rect.height / 2;
      const bandCenter = top + (bottom - top) / 2;
      window.scrollBy({ top: elCenter - bandCenter, behavior: 'smooth' });
    }
  }

  function openModal(state, targetEl) {
    modalState = state;
    lastFocused = document.activeElement;
    hideAffordanceButtons();
    titleEl.textContent = state.mode === 'add' ? 'Add comment' : 'Edit comment';
    const key = draftKey(state);
    const hasDraft =
      key && Object.prototype.hasOwnProperty.call(drafts, key);
    textarea.value = hasDraft ? drafts[key] : state.body || '';
    backdrop.hidden = false;
    document.body.classList.add('mdc-popup-open');
    updateAiBarVisibility();
    const el = targetEl || resolveTargetEl(state);
    setHighlight(el);
    // Reserve scroll room below the content so blocks under the docked bar can
    // still be scrolled into view, then surface the highlighted target.
    const barH = modalEl.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--mdc-popup-pad', barH + 24 + 'px');
    ensureTargetVisible(el);
    persist();
    textarea.focus();
    const len = textarea.value.length;
    textarea.setSelectionRange(len, len);
  }

  function closeModal() {
    closeMention();
    backdrop.hidden = true;
    modalState = null;
    clearHighlight();
    document.body.classList.remove('mdc-popup-open');
    updateAiBarVisibility();
    restoreAffordance();
    persist();
    if (lastFocused && typeof lastFocused.focus === 'function') {
      lastFocused.focus();
    }
    lastFocused = null;
  }

  function saveModal() {
    if (!modalState) {
      return;
    }
    const body = textarea.value;
    if (body.trim() === '') {
      textarea.classList.add('mdc-invalid');
      textarea.focus();
      return;
    }
    if (modalState.mode === 'add') {
      vscode.postMessage({
        type: 'addComment',
        sourceEnd: modalState.sourceEnd,
        body: body,
        docVersion: docVersion,
      });
    } else {
      vscode.postMessage({
        type: 'editComment',
        commentIndex: modalState.commentIndex,
        body: body,
        orig: {
          author: modalState.author || '',
          date: modalState.date || '',
          body: modalState.body || '',
        },
        docVersion: docVersion,
      });
    }
    discardDraft(modalState);
    closeModal();
  }

  // Persist the in-progress text on every keystroke so it survives a closed
  // popup, a re-render, or a reloaded view. Emptying the textarea drops the
  // draft — that's the "clear it manually" path.
  function saveDraft() {
    const key = draftKey(modalState);
    if (!key) {
      return;
    }
    if (textarea.value === '') {
      delete drafts[key];
    } else {
      drafts[key] = textarea.value;
    }
    refreshDraftMarkers();
    persist();
  }

  function discardDraft(state) {
    const key = draftKey(state);
    if (key) {
      delete drafts[key];
      refreshDraftMarkers();
    }
  }

  textarea.addEventListener('input', function () {
    textarea.classList.remove('mdc-invalid');
    saveDraft();
    checkMention();
  });

  textarea.addEventListener('keydown', function (e) {
    if (!mentionActive || mentionListEl.hidden) {
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      moveMentionSel(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      moveMentionSel(-1);
    } else if (e.key === 'Enter' && mentionSelIdx >= 0) {
      e.preventDefault();
      e.stopPropagation();
      acceptMention(mentionSelIdx);
    } else if (e.key === 'Tab') {
      if (mentionFiles.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        acceptMention(mentionSelIdx >= 0 ? mentionSelIdx : 0);
      }
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      closeMention();
    }
  });

  textarea.addEventListener('blur', function () {
    setTimeout(closeMention, 150);
  });

  cancelBtn.addEventListener('click', closeModal);
  saveBtn.addEventListener('click', saveModal);
  backdrop.addEventListener('mousedown', function (e) {
    if (e.target === backdrop) {
      closeModal();
    }
  });

  backdrop.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      // Handled here while the editor has focus; stop it reaching the global
      // Escape handler so a single press doesn't also close the search.
      e.stopPropagation();
      closeModal();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      saveModal();
    } else if (e.key === 'Tab') {
      trapFocus(e);
    }
  });

  function trapFocus(e) {
    const focusables = [textarea, cancelBtn, saveBtn];
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // ---------------------------------------------------------------------------
  // @ file mention autocomplete
  // ---------------------------------------------------------------------------
  let mentionActive = false;
  let mentionStart = -1;
  let mentionFiles = [];
  let mentionSelIdx = -1;

  function closeMention() {
    mentionActive = false;
    mentionStart = -1;
    mentionFiles = [];
    mentionSelIdx = -1;
    mentionListEl.hidden = true;
    mentionListEl.innerHTML = '';
  }

  function renderMentionItems() {
    mentionListEl.innerHTML = '';
    if (mentionFiles.length === 0) {
      mentionListEl.hidden = true;
      return;
    }
    mentionFiles.forEach(function (file, i) {
      const li = document.createElement('li');
      li.className = 'mdc-mention-item';
      li.setAttribute('role', 'option');
      const rel = file.rel || file;
      const lastSlash = rel.lastIndexOf('/');
      const name = lastSlash >= 0 ? rel.slice(lastSlash + 1) : rel;
      const dir = lastSlash >= 0 ? rel.slice(0, lastSlash + 1) : '';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'mdc-mention-name';
      nameSpan.textContent = name;
      li.appendChild(nameSpan);
      if (dir) {
        const pathSpan = document.createElement('span');
        pathSpan.className = 'mdc-mention-path';
        pathSpan.textContent = dir;
        li.appendChild(pathSpan);
      }
      li.addEventListener('mousedown', function (e) {
        e.preventDefault();
        acceptMention(i);
      });
      mentionListEl.appendChild(li);
    });
    mentionListEl.hidden = false;
  }

  function setMentionSel(idx) {
    const items = mentionListEl.querySelectorAll('.mdc-mention-item');
    items.forEach(function (item, i) {
      item.classList.toggle('mdc-mention-item-active', i === idx);
      if (i === idx) {
        item.scrollIntoView({ block: 'nearest' });
      }
    });
    mentionSelIdx = idx;
  }

  function moveMentionSel(delta) {
    const count = mentionFiles.length;
    if (count === 0) {
      return;
    }
    let next = mentionSelIdx + delta;
    if (next < 0) {
      next = count - 1;
    }
    if (next >= count) {
      next = 0;
    }
    setMentionSel(next);
  }

  function acceptMention(idx) {
    const file = mentionFiles[idx];
    if (!file) {
      return;
    }
    const rel = file.rel || file;
    const link = file.link || rel;
    const lastSlash = rel.lastIndexOf('/');
    const name = lastSlash >= 0 ? rel.slice(lastSlash + 1) : rel;
    const insert = '[' + name + '](' + link + ')';
    const pos = textarea.selectionStart;
    const before = textarea.value.slice(0, mentionStart);
    const after = textarea.value.slice(pos);
    textarea.value = before + insert + after;
    const newPos = mentionStart + insert.length;
    textarea.setSelectionRange(newPos, newPos);
    closeMention();
    saveDraft();
    textarea.focus();
  }

  function checkMention() {
    const pos = textarea.selectionStart;
    const text = textarea.value;
    let atPos = -1;
    for (let i = pos - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === '@') {
        atPos = i;
        break;
      }
      if (/[\s\n]/.test(ch)) {
        break;
      }
    }
    if (atPos === -1) {
      if (mentionActive) {
        closeMention();
      }
      return;
    }
    mentionActive = true;
    mentionStart = atPos;
    const query = text.slice(atPos + 1, pos);
    vscode.postMessage({ type: 'queryWorkspaceFiles', query: query });
  }

  // ---------------------------------------------------------------------------
  // Markdown source editor
  // ---------------------------------------------------------------------------
  const mdEditBackdrop = document.createElement('div');
  mdEditBackdrop.className = 'mdc-modal-backdrop';
  mdEditBackdrop.hidden = true;
  mdEditBackdrop.innerHTML =
    '<div class="mdc-modal" role="dialog" aria-modal="false" aria-labelledby="mdc-mdedit-title">' +
    '<h2 id="mdc-mdedit-title" class="mdc-modal-title">Edit markdown source</h2>' +
    '<div class="mdc-mded-wrap">' +
    '<pre class="mdc-mded-overlay" aria-hidden="true"></pre>' +
    '<textarea id="mdc-mdedit-textarea" class="mdc-modal-textarea mdc-mdedit-textarea" rows="12" ' +
    'placeholder="Markdown source…" aria-label="Markdown source"></textarea>' +
    '</div>' +
    '<div class="mdc-modal-foot">' +
    '<div class="mdc-modal-hint"><kbd>Esc</kbd> to discard · <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> to save</div>' +
    '<div class="mdc-modal-buttons">' +
    '<button type="button" class="mdc-modal-cancel mdc-mdedit-cancel">Discard</button>' +
    '<button type="button" class="mdc-modal-save mdc-mdedit-save" disabled>Save</button>' +
    '</div>' +
    '</div>' +
    '</div>';
  document.body.appendChild(mdEditBackdrop);

  const mdEditModalEl = mdEditBackdrop.querySelector('.mdc-modal');
  const mdEditTextarea = mdEditBackdrop.querySelector('.mdc-mdedit-textarea');
  const mdEditOverlay = mdEditBackdrop.querySelector('.mdc-mded-overlay');
  const mdEditCancelBtn = mdEditBackdrop.querySelector('.mdc-mdedit-cancel');
  const mdEditSaveBtn = mdEditBackdrop.querySelector('.mdc-mdedit-save');

  let mdEditOriginal = '';
  let mdEditSourceLine = -1;
  let mdEditSourceEnd = -1;

  function updateMdSaveBtn() {
    mdEditSaveBtn.disabled = mdEditTextarea.value === mdEditOriginal;
  }

  // ---------------------------------------------------------------------------
  // Markdown source editor — syntax highlight overlay
  // ---------------------------------------------------------------------------
  // A <pre> positioned behind the transparent <textarea> mirrors its content
  // with lightweight regex-based Markdown token coloring. The textarea's text is
  // made transparent so only the pre's colored spans are visible; the caret and
  // selection highlight remain in the textarea layer.

  function mdhEsc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Highlight inline tokens within a single raw line. Returns an HTML string.
  function mdhInline(raw) {
    var result = '';
    var i = 0;
    var len = raw.length;
    while (i < len) {
      var ch = raw[i];

      // Inline code span: one or more backticks
      if (ch === '`') {
        var t = 0, j = i;
        while (j < len && raw[j] === '`') { j++; t++; }
        var delim = '`'.repeat(t);
        var closeAt = raw.indexOf(delim, j);
        if (closeAt !== -1 && (closeAt + t >= len || raw[closeAt + t] !== '`')) {
          result += '<span class="mh-icode">' + mdhEsc(raw.slice(i, closeAt + t)) + '</span>';
          i = closeAt + t;
          continue;
        }
        result += mdhEsc(ch); i++; continue;
      }

      // HTML comment <!-- ... -->
      if (ch === '<' && raw.slice(i, i + 4) === '<!--') {
        var cc = raw.indexOf('-->', i + 4);
        if (cc !== -1) {
          result += '<span class="mh-comment">' + mdhEsc(raw.slice(i, cc + 3)) + '</span>';
          i = cc + 3; continue;
        }
      }

      // Bold ** or __ (must check before single-star italic)
      if ((ch === '*' || ch === '_') && raw[i + 1] === ch && raw[i + 2] !== ch) {
        var cb = raw.indexOf(ch + ch, i + 2);
        if (cb !== -1) {
          result += '<span class="mh-bold">' + mdhEsc(raw.slice(i, cb + 2)) + '</span>';
          i = cb + 2; continue;
        }
      }

      // Italic * or _ (single)
      if ((ch === '*' || ch === '_') && raw[i + 1] !== ch) {
        var ci = raw.indexOf(ch, i + 1);
        if (ci !== -1 && raw[ci + 1] !== ch) {
          result += '<span class="mh-italic">' + mdhEsc(raw.slice(i, ci + 1)) + '</span>';
          i = ci + 1; continue;
        }
      }

      // Image ![alt](url) or link [text](url)
      if ((ch === '!' && raw[i + 1] === '[') || ch === '[') {
        var isImg = ch === '!';
        var ts = isImg ? i + 2 : i + 1;
        var closeTxt = raw.indexOf(']', ts);
        if (closeTxt !== -1 && raw[closeTxt + 1] === '(') {
          var closeUrl = raw.indexOf(')', closeTxt + 2);
          if (closeUrl !== -1) {
            result += '<span class="mh-punct">' + mdhEsc(isImg ? '![' : '[') + '</span>' +
                      '<span class="mh-ltext">' + mdhEsc(raw.slice(ts, closeTxt)) + '</span>' +
                      '<span class="mh-punct">](</span>' +
                      '<span class="mh-lurl">' + mdhEsc(raw.slice(closeTxt + 2, closeUrl)) + '</span>' +
                      '<span class="mh-punct">)</span>';
            i = closeUrl + 1; continue;
          }
        }
      }

      result += mdhEsc(ch); i++;
    }
    return result;
  }

  // Highlight a full block of Markdown text. Returns HTML for the overlay pre.
  function highlightMarkdown(text) {
    var lines = text.split('\n');
    var out = [];
    var inFence = false;
    var fenceCh = '';
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      var fenceM = /^(`{3,}|~{3,})/.exec(line);
      if (fenceM) {
        var fc = fenceM[1][0];
        if (!inFence) {
          inFence = true; fenceCh = fc;
          out.push('<span class="mh-fence">' + mdhEsc(line) + '</span>');
          continue;
        } else if (fc === fenceCh) {
          inFence = false;
          out.push('<span class="mh-fence">' + mdhEsc(line) + '</span>');
          continue;
        }
      }
      if (inFence) {
        out.push('<span class="mh-code">' + mdhEsc(line) + '</span>');
        continue;
      }
      // Heading
      var headM = /^(#{1,6})([ \t]|$)/.exec(line);
      if (headM) {
        out.push('<span class="mh-hmark">' + mdhEsc(headM[1]) + '</span>' +
                 '<span class="mh-heading">' + mdhInline(line.slice(headM[1].length)) + '</span>');
        continue;
      }
      // Block quote
      if (line.charAt(0) === '>') {
        out.push('<span class="mh-quote">' + mdhEsc(line) + '</span>');
        continue;
      }
      // Horizontal rule
      if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
        out.push('<span class="mh-hr">' + mdhEsc(line) + '</span>');
        continue;
      }
      out.push(mdhInline(line));
    }
    return out.join('\n');
  }

  function syncMdHighlight() {
    if (!mdEditOverlay) { return; }
    mdEditOverlay.innerHTML = highlightMarkdown(mdEditTextarea.value) + '\n';
    mdEditOverlay.scrollTop = mdEditTextarea.scrollTop;
  }

  function openMdEditor(text, sourceLine, sourceEnd) {
    mdEditOriginal = text;
    mdEditSourceLine = sourceLine;
    mdEditSourceEnd = sourceEnd;
    mdEditTextarea.value = text;
    mdEditBackdrop.hidden = false;
    document.body.classList.add('mdc-popup-open');
    const barH = mdEditModalEl.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--mdc-popup-pad', barH + 24 + 'px');
    // Highlight the block being edited, the same way the comment popup marks its
    // target, so it's clear which paragraph the source editor belongs to.
    const targetEl = content.querySelector('[data-source-line="' + sourceLine + '"]');
    setHighlight(targetEl, 'mdc-target-edit');
    ensureTargetVisible(targetEl);
    updateMdSaveBtn();
    updateAiBarVisibility();
    mdEditTextarea.focus();
    mdEditTextarea.setSelectionRange(0, 0);
    mdEditTextarea.scrollTop = 0;
    syncMdHighlight();
  }

  function closeMdEditor() {
    mdEditBackdrop.hidden = true;
    clearHighlight();
    document.body.classList.remove('mdc-popup-open');
    updateAiBarVisibility();
    restoreAffordance();
  }

  function saveMdEditor() {
    if (mdEditSaveBtn.disabled) {
      return;
    }
    vscode.postMessage({
      type: 'saveBlockMarkdown',
      text: mdEditTextarea.value,
      sourceLine: mdEditSourceLine,
      sourceEnd: mdEditSourceEnd,
      docVersion: docVersion,
    });
    mdEditOriginal = mdEditTextarea.value;
    updateMdSaveBtn();
  }

  mdEditTextarea.addEventListener('input', function () {
    updateMdSaveBtn();
    syncMdHighlight();
  });
  mdEditTextarea.addEventListener('scroll', function () {
    if (mdEditOverlay) { mdEditOverlay.scrollTop = mdEditTextarea.scrollTop; }
  });
  mdEditCancelBtn.addEventListener('click', closeMdEditor);
  mdEditSaveBtn.addEventListener('click', saveMdEditor);

  mdEditBackdrop.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMdEditor();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      saveMdEditor();
    } else if (e.key === 'Tab') {
      mdEditTrapFocus(e);
    }
  });

  function mdEditTrapFocus(e) {
    const focusables = [mdEditTextarea, mdEditCancelBtn, mdEditSaveBtn];
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // ---------------------------------------------------------------------------
  // "Address comments" AI bar (bottom-right)
  // ---------------------------------------------------------------------------
  // A floating bar that hands the document's comments to the configured coding
  // agent (Claude Code / Codex / Copilot / Antigravity) so it revises the prose
  // to address them. The agent and run mode are chosen in Settings; the model
  // and effort are picked here, per run. The host owns the actual run — this bar
  // only collects the choice, relays the intent, and reflects status.
  const aiBar = document.createElement('div');
  aiBar.className = 'mdc-ai-bar';
  aiBar.hidden = true;

  const aiRow = document.createElement('div');
  aiRow.className = 'mdc-ai-row';

  const aiAgentLabel = document.createElement('span');
  aiAgentLabel.className = 'mdc-ai-agent';

  const aiModelSelect = document.createElement('select');
  aiModelSelect.className = 'mdc-ai-select mdc-ai-model';
  aiModelSelect.setAttribute('aria-label', 'AI model');
  aiModelSelect.title = 'Model';

  const aiEffortSelect = document.createElement('select');
  aiEffortSelect.className = 'mdc-ai-select mdc-ai-effort';
  aiEffortSelect.setAttribute('aria-label', 'Reasoning effort');
  aiEffortSelect.title = 'Effort';
  [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']].forEach(function (pair) {
    const opt = document.createElement('option');
    opt.value = pair[0];
    opt.textContent = pair[1];
    aiEffortSelect.appendChild(opt);
  });

  const aiCopyBtn = document.createElement('button');
  aiCopyBtn.type = 'button';
  aiCopyBtn.className = 'mdc-ai-icon-btn mdc-ai-copy';
  aiCopyBtn.setAttribute('aria-label', 'Copy prompt');
  aiCopyBtn.setAttribute('data-hint', 'Copy prompt');
  aiCopyBtn.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path fill="currentColor" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/>' +
    '<path fill="currentColor" d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/>' +
    '</svg>';

  const aiRunBtn = document.createElement('button');
  aiRunBtn.type = 'button';
  aiRunBtn.className = 'mdc-ai-run';
  aiRunBtn.textContent = 'Address comments';
  aiRunBtn.title = 'Use the configured AI agent to address all comments';

  // Shown while a run is in flight.
  const aiStopBtn = document.createElement('button');
  aiStopBtn.type = 'button';
  aiStopBtn.className = 'mdc-ai-stop';
  aiStopBtn.textContent = 'Stop';
  aiStopBtn.title = 'Stop the running agent';
  aiStopBtn.hidden = true;

  // Shown after a run that changed the file, for the review / approve step.
  const aiReviewBtn = document.createElement('button');
  aiReviewBtn.type = 'button';
  aiReviewBtn.className = 'mdc-ai-btn mdc-ai-review';
  aiReviewBtn.textContent = 'Review changes';
  aiReviewBtn.title = 'Open a diff of the agent’s changes';
  aiReviewBtn.hidden = true;

  const aiApproveBtn = document.createElement('button');
  aiApproveBtn.type = 'button';
  aiApproveBtn.className = 'mdc-ai-run mdc-ai-approve';
  aiApproveBtn.textContent = 'Approve';
  aiApproveBtn.title = 'Keep the agent’s changes';
  aiApproveBtn.hidden = true;

  const aiRejectBtn = document.createElement('button');
  aiRejectBtn.type = 'button';
  aiRejectBtn.className = 'mdc-ai-btn mdc-ai-reject';
  aiRejectBtn.textContent = 'Revert';
  aiRejectBtn.title = 'Discard the agent’s changes and restore the original';
  aiRejectBtn.hidden = true;

  aiRow.appendChild(aiAgentLabel);
  aiRow.appendChild(aiModelSelect);
  aiRow.appendChild(aiEffortSelect);
  aiRow.appendChild(aiRunBtn);
  aiRow.appendChild(aiStopBtn);
  aiRow.appendChild(aiReviewBtn);
  aiRow.appendChild(aiApproveBtn);
  aiRow.appendChild(aiRejectBtn);
  aiRow.appendChild(aiCopyBtn);

  const aiStatus = document.createElement('div');
  aiStatus.className = 'mdc-ai-status';
  aiStatus.setAttribute('role', 'status');
  aiStatus.setAttribute('aria-live', 'polite');
  aiStatus.hidden = true;

  aiBar.appendChild(aiRow);
  aiBar.appendChild(aiStatus);
  document.body.appendChild(aiBar);

  let aiConfig = null; // { agent, label, runMode, model, effort }
  let aiModels = []; // detected model list for the current agent
  let aiInstalled = true; // until the host's detection says otherwise
  let aiBusy = false; // a run is in flight (mirrors aiPhase === 'running')
  let aiPhase = 'idle'; // 'idle' | 'running' | 'review' — drives which controls show
  let aiStatusTimer = null;
  let aiSelModel = typeof prevState.aiModel === 'string' ? prevState.aiModel : null;
  let aiSelEffort = typeof prevState.aiEffort === 'string' ? prevState.aiEffort : null;

  function applyAiConfig(cfg) {
    if (!cfg) {
      return;
    }
    const prevAgent = aiConfig && aiConfig.agent;
    aiConfig = cfg;
    // Switching agents invalidates the detected models / installed-state until
    // the host re-detects and posts a fresh aiInfo for the new agent.
    if (prevAgent && prevAgent !== cfg.agent) {
      aiModels = [];
      aiInstalled = true;
      aiSelModel = cfg.model || '';
    }
    aiAgentLabel.textContent = cfg.label || cfg.agent || 'AI';
    aiAgentLabel.title =
      (cfg.label || 'AI') +
      ' · ' +
      (cfg.runMode === 'headless' ? 'headless' : 'terminal') +
      ' · change the agent and run mode in Settings';

    // Seed model/effort from the settings defaults until the user picks their own.
    if (aiSelEffort == null) {
      aiSelEffort = cfg.effort || 'medium';
    }
    setSelectValue(aiEffortSelect, aiSelEffort, 'medium');
    if (aiSelModel == null) {
      aiSelModel = cfg.model || '';
    }
    rebuildModelOptions();
    aiRunBtn.disabled = aiBusy || !aiInstalled;
  }

  function rebuildModelOptions(models) {
    const list = Array.isArray(models) ? models.slice() : aiModels.slice();
    const want = aiModelSelect.value || aiSelModel || (aiConfig && aiConfig.model) || '';
    aiModelSelect.textContent = '';

    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'Agent default';
    aiModelSelect.appendChild(def);

    // Keep the configured / selected model selectable even if detection omitted it.
    if (want && list.indexOf(want) === -1) {
      list.push(want);
    }
    list.forEach(function (m) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      aiModelSelect.appendChild(opt);
    });
    setSelectValue(aiModelSelect, want, '');
  }

  // Assign a value, falling back when the option isn't present (a <select>
  // silently keeps its old value when assigned one it doesn't have).
  function setSelectValue(select, value, fallback) {
    select.value = value;
    if (select.value !== value) {
      select.value = fallback;
    }
  }

  function onAiInfo(msg) {
    if (!aiConfig || msg.agent !== aiConfig.agent) {
      return; // detection for a since-changed agent — ignore
    }
    aiModels = Array.isArray(msg.models) ? msg.models : [];
    aiInstalled = msg.installed !== false;
    rebuildModelOptions(aiModels);
    aiRunBtn.disabled = aiPhase !== 'idle' || !aiInstalled;
    if (!aiInstalled) {
      showAiStatus('error', (aiConfig.label || 'The agent') + ' CLI was not found on your PATH.');
    } else if (aiPhase === 'idle') {
      hideAiStatus();
    }
  }

  // Show exactly the controls for the current phase: idle = pick model/effort +
  // Address; running = Stop; review = Review / Approve / Revert.
  function setPhase(phase) {
    aiPhase = phase === 'running' || phase === 'review' ? phase : 'idle';
    const idle = aiPhase === 'idle';
    aiBusy = aiPhase === 'running';
    aiModelSelect.hidden = !idle;
    aiEffortSelect.hidden = !idle;
    aiCopyBtn.hidden = !idle;
    aiRunBtn.hidden = !idle;
    aiStopBtn.hidden = aiPhase !== 'running';
    aiReviewBtn.hidden = aiPhase !== 'review';
    aiApproveBtn.hidden = aiPhase !== 'review';
    aiRejectBtn.hidden = aiPhase !== 'review';
    aiRunBtn.disabled = !idle || !aiInstalled;
    updateAiBarVisibility();
  }

  function onAiStatus(msg) {
    const state = msg && msg.state;
    if (msg && typeof msg.phase === 'string') {
      setPhase(msg.phase);
    }
    showAiStatus(state, msg && msg.message);
    // Transient outcomes fade; errors, in-progress and review states stay put.
    if (state === 'done' || state === 'launched') {
      scheduleStatusHide();
    }
  }

  function showAiStatus(state, message) {
    if (aiStatusTimer) {
      clearTimeout(aiStatusTimer);
      aiStatusTimer = null;
    }
    aiStatus.textContent = message || '';
    aiStatus.hidden = !message;
    aiStatus.className = 'mdc-ai-status mdc-ai-' + (state || 'info');
  }

  function scheduleStatusHide() {
    if (aiStatusTimer) {
      clearTimeout(aiStatusTimer);
    }
    aiStatusTimer = setTimeout(hideAiStatus, 6000);
  }

  function hideAiStatus() {
    if (aiStatusTimer) {
      clearTimeout(aiStatusTimer);
      aiStatusTimer = null;
    }
    aiStatus.hidden = true;
    aiStatus.textContent = '';
  }

  function runAddress() {
    if (aiPhase !== 'idle' || aiRunBtn.disabled) {
      return;
    }
    if (!content.querySelector('.mdc-comment')) {
      showAiStatus('error', 'There are no comments to address.');
      return;
    }
    setPhase('running'); // optimistic — host confirms or returns us to idle
    showAiStatus('running', 'Starting…');
    vscode.postMessage({
      type: 'addressComments',
      model: aiModelSelect.value,
      effort: aiEffortSelect.value,
    });
  }

  function stopAddress() {
    if (aiPhase !== 'running') {
      return;
    }
    showAiStatus('running', 'Stopping…');
    vscode.postMessage({ type: 'stopAddress' });
  }

  function reviewChanges() {
    if (aiPhase !== 'review') {
      return;
    }
    vscode.postMessage({ type: 'reviewChanges' });
  }

  function approveChanges() {
    if (aiPhase !== 'review') {
      return;
    }
    vscode.postMessage({ type: 'approveChanges' });
  }

  function rejectChanges() {
    if (aiPhase !== 'review') {
      return;
    }
    vscode.postMessage({ type: 'rejectChanges' });
  }

  aiCopyBtn.addEventListener('click', function () {
    if (aiPhase !== 'idle') { return; }
    if (!content.querySelector('.mdc-comment')) {
      showAiStatus('error', 'There are no comments to build a prompt for.');
      return;
    }
    vscode.postMessage({ type: 'copyPrompt', effort: aiEffortSelect.value });
  });
  aiRunBtn.addEventListener('click', runAddress);
  aiStopBtn.addEventListener('click', stopAddress);
  aiReviewBtn.addEventListener('click', reviewChanges);
  aiApproveBtn.addEventListener('click', approveChanges);
  aiRejectBtn.addEventListener('click', rejectChanges);
  aiModelSelect.addEventListener('change', function () {
    aiSelModel = aiModelSelect.value;
    persist();
  });
  aiEffortSelect.addEventListener('change', function () {
    aiSelEffort = aiEffortSelect.value;
    persist();
  });

  // Show the bar when there are comments to act on (or a run / review is in
  // progress), and never over the docked add/edit editor (same bottom strip).
  function updateAiBarVisibility() {
    const hasUnresolved = !!content.querySelector('.mdc-comment:not(.mdc-resolved)');
    const modalOpen = !backdrop.hidden || !mdEditBackdrop.hidden;
    const active = aiPhase !== 'idle';
    aiBar.hidden = !(aiConfig && (hasUnresolved || active) && !modalOpen);
  }
  // ---------------------------------------------------------------------------
  // Find-in-comments
  // ---------------------------------------------------------------------------
  // The slim find bar in the top toolbar highlights query matches inside comment
  // bubbles and steps through them. Matches are wrapped in <mark> nodes injected
  // into the live DOM; clearing the query or a host re-render removes them. The
  // host owns the document, so this is purely a view-side affordance — it never
  // edits content.
  const searchBar = document.querySelector('.mdc-search');
  const searchToggleBtn = document.getElementById('mdc-search-toggle');
  const searchInput = document.getElementById('mdc-search-input');
  const searchCount = document.getElementById('mdc-search-count');
  const searchPrevBtn = document.getElementById('mdc-search-prev');
  const searchNextBtn = document.getElementById('mdc-search-next');
  const searchClearBtn = document.getElementById('mdc-search-clear');

  let searchQuery = typeof prevState.searchQuery === 'string' ? prevState.searchQuery : '';
  let searchHits = []; // the injected <mark> nodes, in document order
  let searchActive = -1; // index of the current hit within searchHits

  // Unwrap every <mark.mdc-search-hit> we injected, restoring (and re-merging)
  // the original text nodes.
  function clearSearchHighlights() {
    const marks = content.querySelectorAll('mark.mdc-search-hit');
    for (let i = 0; i < marks.length; i++) {
      const mark = marks[i];
      const parent = mark.parentNode;
      if (!parent) {
        continue;
      }
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
      parent.normalize();
    }
    searchHits = [];
    searchActive = -1;
  }

  // Search the full page content. Action buttons and resolved badges are
  // excluded so their labels don't produce false matches.
  function searchContainers() {
    return [content];
  }

  // Wrap each case-insensitive occurrence of `lowerQuery` within `root`'s text
  // nodes in a <mark>. Collects the text nodes first so freshly inserted marks
  // aren't re-visited. Text inside .mdc-comment-actions is skipped.
  function highlightWithin(root, lowerQuery) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue) {
        let skip = false;
        let el = node.parentElement;
        while (el && el !== root) {
          if (el.classList && el.classList.contains('mdc-comment-actions')) {
            skip = true;
            break;
          }
          el = el.parentElement;
        }
        if (!skip) {
          textNodes.push(node);
        }
      }
    }
    for (let i = 0; i < textNodes.length; i++) {
      const tn = textNodes[i];
      const text = tn.nodeValue;
      const lower = text.toLowerCase();
      let from = lower.indexOf(lowerQuery);
      if (from === -1) {
        continue;
      }
      const frag = document.createDocumentFragment();
      let last = 0;
      while (from !== -1) {
        if (from > last) {
          frag.appendChild(document.createTextNode(text.slice(last, from)));
        }
        const mark = document.createElement('mark');
        mark.className = 'mdc-search-hit';
        mark.textContent = text.slice(from, from + lowerQuery.length);
        frag.appendChild(mark);
        last = from + lowerQuery.length;
        from = lower.indexOf(lowerQuery, last);
      }
      if (last < text.length) {
        frag.appendChild(document.createTextNode(text.slice(last)));
      }
      if (tn.parentNode) {
        tn.parentNode.replaceChild(frag, tn);
      }
    }
  }

  function runSearch(jumpToFirst) {
    const raw = searchInput ? searchInput.value : '';
    searchQuery = raw;
    clearSearchHighlights();
    const query = raw.trim();
    if (query === '') {
      updateSearchCount();
      persist();
      return;
    }
    const lowerQuery = query.toLowerCase();
    const containers = searchContainers();
    for (let i = 0; i < containers.length; i++) {
      highlightWithin(containers[i], lowerQuery);
    }
    searchHits = Array.prototype.slice.call(
      content.querySelectorAll('mark.mdc-search-hit')
    );
    if (searchHits.length) {
      setActiveHit(jumpToFirst ? 0 : Math.max(0, searchActive), jumpToFirst);
    }
    updateSearchCount();
    persist();
  }

  function setActiveHit(index, scrollIntoView) {
    const n = searchHits.length;
    if (!n) {
      searchActive = -1;
      return;
    }
    searchActive = ((index % n) + n) % n;
    for (let i = 0; i < n; i++) {
      searchHits[i].classList.toggle('mdc-search-hit-current', i === searchActive);
    }
    if (scrollIntoView !== false) {
      searchHits[searchActive].scrollIntoView({ block: 'center' });
    }
    updateSearchCount();
  }

  function stepSearch(delta) {
    if (searchHits.length) {
      setActiveHit(searchActive + delta, true);
    }
  }

  function updateSearchCount() {
    if (!searchCount) {
      return;
    }
    const q = searchInput ? searchInput.value.trim() : '';
    if (!q) {
      searchCount.textContent = '';
    } else if (!searchHits.length) {
      searchCount.textContent = 'No results';
    } else {
      searchCount.textContent = searchActive + 1 + '/' + searchHits.length;
    }
  }

  function searchIsOpen() {
    return searchBar ? !searchBar.hidden : false;
  }

  // Reveal the collapsed find bar and focus the input (selecting any restored
  // query so a fresh search overwrites it).
  function openSearch() {
    if (searchBar) {
      searchBar.hidden = false;
    }
    // The find bar carries its own × close, so the now-redundant 🔍 toggle steps
    // aside while it's open.
    if (searchToggleBtn) {
      searchToggleBtn.setAttribute('aria-expanded', 'true');
      searchToggleBtn.hidden = true;
    }
    if (searchInput) {
      searchInput.focus();
      searchInput.select();
    }
    persist();
  }

  // Collapse the find bar: drop the query and its highlights, then return focus
  // to the toggle so keyboard users aren't stranded.
  function closeSearch() {
    if (searchInput) {
      searchInput.value = '';
    }
    searchQuery = '';
    clearSearchHighlights();
    updateSearchCount();
    if (searchBar) {
      searchBar.hidden = true;
    }
    if (searchToggleBtn) {
      searchToggleBtn.setAttribute('aria-expanded', 'false');
      searchToggleBtn.hidden = false;
      searchToggleBtn.focus();
    }
    persist();
  }

  function toggleSearch() {
    if (searchIsOpen()) {
      closeSearch();
    } else {
      openSearch();
    }
  }

  // Re-apply the active query after the host swaps #mdc-content (the re-render
  // drops our injected <mark> nodes), keeping the current position if possible.
  function reapplySearch() {
    if (searchInput && searchInput.value.trim() !== '') {
      runSearch(false);
    } else {
      searchHits = [];
      searchActive = -1;
      updateSearchCount();
    }
  }

  if (searchInput) {
    searchInput.addEventListener('input', function () {
      searchActive = -1;
      runSearch(true);
    });
    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        stepSearch(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        // Handled here while the input has focus; stop it reaching the global
        // Escape handler so the same press doesn't act twice.
        e.stopPropagation();
        closeSearch();
      }
    });
  }
  if (searchToggleBtn) {
    searchToggleBtn.addEventListener('click', toggleSearch);
  }
  if (searchPrevBtn) {
    searchPrevBtn.addEventListener('click', function () {
      stepSearch(-1);
    });
  }
  if (searchNextBtn) {
    searchNextBtn.addEventListener('click', function () {
      stepSearch(1);
    });
  }
  // The × button closes the bar (clearing the query); Esc does the same.
  if (searchClearBtn) {
    searchClearBtn.addEventListener('click', closeSearch);
  }
  // ⌘/Ctrl+F opens the find bar from anywhere in the view (it's hidden by
  // default); when already open, focus the input.
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      if (searchIsOpen()) {
        if (searchInput) {
          searchInput.focus();
          searchInput.select();
        }
      } else {
        openSearch();
      }
    }
  });

  // Escape pressed while focus is on the page (not inside the comment editor or
  // the search input, which handle it themselves and stop it here). Dismiss one
  // thing per press, most transient first: an open comment editor, then the
  // search bar.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') {
      return;
    }
    if (!backdrop.hidden) {
      e.preventDefault();
      closeModal();
    } else if (!mdEditBackdrop.hidden) {
      e.preventDefault();
      closeMdEditor();
    } else if (searchIsOpen()) {
      e.preventDefault();
      closeSearch();
    }
  });

  // ---------------------------------------------------------------------------
  // "Remove resolved" bulk action
  // ---------------------------------------------------------------------------
  // The host tags every resolved comment's bubble with `mdc-resolved`; here we
  // surface a toolbar button (with a live count) whenever any exist and relay a
  // single `removeAllResolved` intent. The host re-resolves the set against the
  // live document and deletes them in one undoable edit.
  const removeResolvedBtn = document.getElementById('mdc-remove-resolved');
  let removeResolvedTimer = null;

  function resolvedCount() {
    return content.querySelectorAll('.mdc-comment.mdc-resolved').length;
  }

  function resetRemoveResolvedBtn() {
    if (removeResolvedTimer) {
      clearTimeout(removeResolvedTimer);
      removeResolvedTimer = null;
    }
    if (removeResolvedBtn) {
      removeResolvedBtn.dataset.confirm = '';
      removeResolvedBtn.classList.remove('mdc-confirm');
    }
  }

  // Show the button (with a count) only when something is resolved. Called on
  // every content update via updateEmptyState.
  function updateResolvedControl() {
    if (!removeResolvedBtn) {
      return;
    }
    const count = resolvedCount();
    removeResolvedBtn.hidden = count === 0;
    if (count === 0) {
      resetRemoveResolvedBtn();
    } else if (removeResolvedBtn.dataset.confirm !== '1') {
      removeResolvedBtn.textContent = 'Remove resolved (' + count + ')';
    }
  }

  if (removeResolvedBtn) {
    removeResolvedBtn.addEventListener('click', function () {
      const count = resolvedCount();
      if (count === 0) {
        return;
      }
      // Two-step confirm: a destructive bulk delete shouldn't fire on one click.
      if (removeResolvedBtn.dataset.confirm === '1') {
        resetRemoveResolvedBtn();
        removeResolvedBtn.textContent = 'Remove resolved (' + count + ')';
        vscode.postMessage({ type: 'removeAllResolved', docVersion: docVersion });
        return;
      }
      removeResolvedBtn.dataset.confirm = '1';
      removeResolvedBtn.classList.add('mdc-confirm');
      removeResolvedBtn.textContent = 'Remove ' + count + ' resolved?';
      removeResolvedTimer = setTimeout(function () {
        if (removeResolvedBtn.isConnected) {
          resetRemoveResolvedBtn();
          updateResolvedControl();
        }
      }, 3500);
    });
  }

  // ---------------------------------------------------------------------------
  // Host messages
  // ---------------------------------------------------------------------------
  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (!msg || !msg.type) {
      return;
    }
    if (msg.type === 'update') {
      applyUpdate(msg);
    } else if (msg.type === 'focusComment') {
      focusComment(msg.commentIndex);
    } else if (msg.type === 'requestAdd') {
      startAddFromCommand();
    } else if (msg.type === 'requestAddress') {
      runAddress();
    } else if (msg.type === 'aiInfo') {
      onAiInfo(msg);
    } else if (msg.type === 'aiStatus') {
      onAiStatus(msg);
    } else if (msg.type === 'promptCopied') {
      showAiStatus('done', 'Prompt copied to clipboard.');
      scheduleStatusHide();
    } else if (msg.type === 'blockMarkdownContent') {
      openMdEditor(msg.text, msg.sourceLine, msg.sourceEnd);
    } else if (msg.type === 'error') {
      showToast(msg.message);
    } else if (msg.type === 'toast') {
      showToast(msg.message);
    } else if (msg.type === 'workspaceFiles') {
      if (mentionActive) {
        mentionFiles = msg.files || [];
        renderMentionItems();
      }
    }
  });

  function applyViewerConfig(cfg) {
    if (!cfg) {
      return;
    }
    const root = document.documentElement;
    if (typeof cfg.fontSize === 'number' && cfg.fontSize > 0) {
      root.style.setProperty('--mdc-font-size', cfg.fontSize + 'px');
    }
    if (typeof cfg.maxWidth === 'number') {
      root.style.setProperty(
        '--mdc-content-max-width',
        cfg.maxWidth > 0 ? cfg.maxWidth + 'px' : 'none'
      );
    }
    if (cfg.colorTheme) {
      const themeClasses = {
        light: 'mdc-theme-light',
        dark: 'mdc-theme-dark',
        'light-modern': 'mdc-theme-light-modern',
        'dark-modern': 'mdc-theme-dark-modern',
      };
      document.body.classList.remove(
        'mdc-theme-light',
        'mdc-theme-dark',
        'mdc-theme-light-modern',
        'mdc-theme-dark-modern'
      );
      const cls = themeClasses[cfg.colorTheme];
      if (cls) {
        document.body.classList.add(cls);
      }
    }
  }

  function applyUpdate(msg) {
    docVersion = msg.version;
    document.body.dataset.docVersion = String(msg.version);
    applyViewerConfig(msg.config);
    applyAiConfig(msg.config && msg.config.ai);

    const keepScroll =
      pendingScrollRestore != null ? pendingScrollRestore : window.scrollY;
    content.innerHTML = msg.html;
    updateEmptyState();
    refreshDraftMarkers();
    window.scrollTo(0, keepScroll);
    pendingScrollRestore = null;

    // The innerHTML swap detached the old nodes; if the editor is still open,
    // re-find and re-highlight its target in the fresh DOM.
    if (!backdrop.hidden && modalState) {
      highlightedEl = null;
      setHighlight(resolveTargetEl(modalState));
    }

    // If an edit modal's target no longer exists, the host will reject it; we
    // leave the modal open so the user keeps their text and can retry.

    // The innerHTML swap also dropped any search highlights — re-apply the active
    // query against the fresh content so matches persist across re-renders.
    reapplySearch();
  }

  function focusComment(index) {
    const el = content.querySelector(
      '.mdc-comment[data-comment-index="' + index + '"]'
    );
    if (!el) {
      return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('mdc-flash');
    // Force reflow so the animation re-triggers on a repeated focus.
    void el.offsetWidth;
    el.classList.add('mdc-flash');
  }

  let toastTimer = null;
  function showToast(message) {
    toastEl.textContent = message || 'Something went wrong.';
    toastEl.hidden = false;
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(function () {
      toastEl.hidden = true;
    }, 4000);
  }

  function updateEmptyState() {
    if (emptyEl) {
      emptyEl.hidden = !!content.querySelector('.mdc-comment');
    }
    updateResolvedControl();
    updateAiBarVisibility();
  }

  // ---------------------------------------------------------------------------
  // State persistence (survives retainContextWhenHidden eviction / reload)
  // ---------------------------------------------------------------------------
  function persist() {
    vscode.setState({
      scrollY: window.scrollY,
      modal: modalState,
      drafts: drafts,
      aiModel: aiSelModel,
      aiEffort: aiSelEffort,
      searchQuery: searchQuery,
    });
  }
  window.addEventListener('scroll', persist, { passive: true });

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  if (prevState.modal) {
  }
  updateEmptyState();
  refreshDraftMarkers();
  // Restore a search query that survived a reload: reopen the (otherwise hidden)
  // find bar and re-apply it to the content rendered into the initial HTML.
  if (searchQuery && searchInput) {
    searchInput.value = searchQuery;
    openSearch();
    runSearch(false);
  }
  vscode.postMessage({ type: 'ready' });
})();
