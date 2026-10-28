// Live log on /runs/:id. Appends the SSE chunks to the <pre> (as text, never HTML), keeps it scrolled
// to the bottom unless the reader scrolled up, and tells htmx to refresh the status block at the end.
(function () {
  "use strict";
  var pre = document.querySelector("pre[data-run-stream]");
  if (!pre || typeof EventSource === "undefined") return;
  var source = new EventSource(pre.getAttribute("data-run-stream"));
  source.addEventListener("log", function (e) {
    var atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
    pre.appendChild(document.createTextNode(JSON.parse(e.data)));
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  });
  source.addEventListener("done", function () {
    source.close();
    document.body.dispatchEvent(new CustomEvent("run-finished"));
  });
})();
