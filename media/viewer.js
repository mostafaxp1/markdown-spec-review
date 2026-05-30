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

  let hoverBlock = null;

  function showAffordanceFor(block) {
    hoverBlock = block;
    const rect = block.getBoundingClientRect();
    addBtn.style.top = Math.max(2, rect.top) + 'px';
    addBtn.style.left = Math.max(2, rect.left - 26) + 'px';
    addBtn.hidden = false;
  }

  function hideAffordance() {
    addBtn.hidden = true;
    hoverBlock = null;
  }

  content.addEventListener('mouseover', function (e) {
    if (!backdrop.hidden) {
      return; // modal open
    }
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
    const sourceEnd = Number(block.getAttribute('data-source-end'));
    const sourceLine = Number(block.getAttribute('data-source-line'));
    hideAffordance();
    openModal({ mode: 'add', sourceEnd: sourceEnd, sourceLine: sourceLine }, block);
  }

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
    '<textarea id="mdc-modal-textarea" class="mdc-modal-textarea" rows="8" ' +
    'placeholder="Type your comment…" aria-label="Comment text"></textarea>' +
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
  const cancelBtn = backdrop.querySelector('.mdc-modal-cancel');
  const saveBtn = backdrop.querySelector('.mdc-modal-save');

  let modalState = null;
  let lastFocused = null;

  // ---- target highlight ----------------------------------------------------
  // While the docked editor is open we mark the block being commented on (add)
  // or the comment bubble being edited (edit) so it's clear what the comment
  // belongs to, even though the preview above stays fully visible.
  let highlightedEl = null;

  function setHighlight(el) {
    if (highlightedEl === el) {
      return;
    }
    clearHighlight();
    if (el && el.classList) {
      el.classList.add('mdc-target');
      highlightedEl = el;
    }
  }

  function clearHighlight() {
    if (highlightedEl && highlightedEl.classList) {
      highlightedEl.classList.remove('mdc-target');
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
    hideAffordance();
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
    backdrop.hidden = true;
    modalState = null;
    clearHighlight();
    document.body.classList.remove('mdc-popup-open');
    updateAiBarVisibility();
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
    const hasComments = !!content.querySelector('.mdc-comment');
    const modalOpen = !backdrop.hidden;
    const active = aiPhase !== 'idle';
    aiBar.hidden = !(aiConfig && (hasComments || active) && !modalOpen);
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

  // We search comment text + meta only — the bar's placeholder is "Search
  // comments", and the action buttons / badges shouldn't match.
  function searchContainers() {
    return content.querySelectorAll('.mdc-comment-body, .mdc-comment-meta');
  }

  // Wrap each case-insensitive occurrence of `lowerQuery` within `root`'s text
  // nodes in a <mark>. Collects the text nodes first so freshly inserted marks
  // aren't re-visited.
  function highlightWithin(root, lowerQuery) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue) {
        textNodes.push(node);
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
    } else if (msg.type === 'error') {
      showToast(msg.message);
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
