// Runs inside the built-in Markdown preview webview.
// Adds click-to-collapse on each comment bubble's header. The preview re-runs
// scripts on every content update, so a delegated listener is all we need.
(function () {
  document.addEventListener('click', function (event) {
    var head = event.target.closest && event.target.closest('.mdc-comment-head');
    if (!head) {
      return;
    }
    var comment = head.closest('.mdc-comment');
    if (comment) {
      comment.classList.toggle('mdc-collapsed');
    }
  });
})();
