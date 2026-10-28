// Small progressive enhancements. Pages work without this file, except opening dialogs
// (project switcher, create and edit forms), which needs it and htmx.
(function () {
  var root = document.documentElement;

  function currentTheme() {
    return root.getAttribute("data-theme") || "system";
  }

  function markTheme() {
    var theme = currentTheme();
    document.querySelectorAll("[data-theme-choice]").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-theme-choice") === theme));
    });
  }

  document.addEventListener("click", function (event) {
    var target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    var option = target.closest(".suggest-item");
    if (option) {
      var owner = suggestOwner(option.parentElement);
      if (owner) pickSuggest(owner, option);
      return;
    }

    var choice = target.closest("[data-theme-choice]");
    if (choice) {
      var theme = choice.getAttribute("data-theme-choice");
      try {
        if (theme === "system") localStorage.removeItem("vantage-theme");
        else localStorage.setItem("vantage-theme", theme);
      } catch (e) {}
      if (theme === "system") root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", theme);
      markTheme();
      return;
    }

    var detailRow = target.closest("[data-detail-url]");
    if (detailRow && !target.closest("a, button, summary, details, input, select, textarea, label") && !selectingIn(detailRow)) {
      openDetail(detailRow);
      return;
    }

    var opener = target.closest("[data-dialog-open]");
    if (opener) {
      var dialog = document.getElementById(opener.getAttribute("data-dialog-open"));
      if (dialog && dialog.showModal) {
        event.preventDefault();
        // A step inside a flow (type picker → form, "Zurück") replaces the open dialog.
        var current = opener.closest("dialog[open]");
        if (current && current !== dialog) current.close();
        openDialog(dialog);
      }
      return;
    }

    if (target.closest("[data-dialog-close]")) {
      var open = target.closest("dialog");
      if (open) open.close();
      return;
    }

    // A click on the backdrop lands on the dialog element itself. Dialogs with a form stay open,
    // so a stray click cannot throw away what was typed; Escape and "Abbrechen" still close them.
    if (target.tagName === "DIALOG" && !target.querySelector("form")) {
      target.close();
      return;
    }

    var dismiss = target.closest("[data-dismiss]");
    if (dismiss) {
      var toast = dismiss.closest(".toast");
      if (toast) toast.remove();
      return;
    }

    var copy = target.closest("[data-copy]");
    if (copy) {
      var source = document.getElementById(copy.getAttribute("data-copy"));
      if (source && navigator.clipboard) {
        navigator.clipboard.writeText(source.textContent.trim()).then(function () {
          var label = copy.querySelector(".copy-label");
          if (!label) return;
          var before = label.textContent;
          label.textContent = "Kopiert";
          setTimeout(function () { label.textContent = before; }, 1600);
        });
      }
      return;
    }

    // On phones the sidebar is a drawer: close it once a link was chosen.
    if (target.closest(".sidebar a")) {
      var toggle = document.getElementById("nav-toggle");
      if (toggle) toggle.checked = false;
    }
  });

  // Rows that open a detail (data-detail-dialog + data-detail-url, DetailDialog): the URL is loaded
  // into the dialog's body. Selecting text in a row, to copy part of a log line, opens nothing.
  function selectingIn(row) {
    var selection = window.getSelection();
    return !!selection && !selection.isCollapsed && row.contains(selection.anchorNode);
  }

  function openDetail(row) {
    var dialog = document.getElementById(row.getAttribute("data-detail-dialog"));
    var body = dialog && dialog.querySelector("[data-detail-body]");
    if (!body || !dialog.showModal || !window.htmx) return;
    var loading = document.createElement("p");
    loading.className = "muted small";
    loading.textContent = "Lädt …";
    body.replaceChildren(loading);
    if (!dialog.open) dialog.showModal();
    window.htmx.ajax("GET", row.getAttribute("data-detail-url"), { target: body, swap: "innerHTML" }).catch(function () {
      loading.textContent = "Der Eintrag ließ sich nicht laden. Bitte noch einmal versuchen.";
    });
  }

  function openDialog(dialog) {
    if (!dialog.open) dialog.showModal();
    var error = dialog.querySelector(".modal-error");
    if (error) error.textContent = "";
    var field = dialog.querySelector("input[type=search][data-filter]");
    if (field) {
      field.value = "";
      filter(field);
      field.focus();
      return;
    }
    var first = dialog.querySelector(".modal-body :is(input:not([type=hidden]):not([disabled]), select, textarea, button)");
    if (first) first.focus();
  }

  // After a success step (token shown once and the like) the page behind is out of date.
  document.addEventListener("close", function (event) {
    var dialog = event.target;
    if (!(dialog instanceof HTMLDialogElement)) return;
    dialog.querySelectorAll("input[data-suggest]").forEach(closeSuggest);
    if (dialog.querySelector("[data-reload-on-close]")) window.location.reload();
  }, true);

  function dialogError(elt, text) {
    var dialog = elt && elt.closest ? elt.closest("dialog") : null;
    // A form shows the problem above its fields; a detail dialog shows it instead of the detail.
    var slot = dialog && dialog.querySelector(".modal-error, [data-detail-body]");
    if (!slot) return;
    var box = document.createElement("div");
    box.className = "form-error";
    box.textContent = text;
    slot.replaceChildren(box);
    slot.scrollIntoView({ block: "nearest" });
  }

  document.addEventListener("htmx:responseError", function (event) {
    dialogError(event.detail.elt, "Das hat nicht geklappt (HTTP " + event.detail.xhr.status + "). Bitte die Seite neu laden und es noch einmal versuchen.");
  });
  document.addEventListener("htmx:sendError", function (event) {
    dialogError(event.detail.elt, "Vantage ist gerade nicht erreichbar. Bitte noch einmal versuchen.");
  });

  document.addEventListener("htmx:afterSwap", function (event) {
    var target = event.detail.target;
    if (!(target instanceof Element)) return;
    if (target.classList.contains("modal-error")) target.scrollIntoView({ block: "nearest" });
    // A success step replaced the dialog's heading: point the dialog's label at the new one.
    if (target.classList.contains("modal-panel")) {
      var dialog = target.closest("dialog");
      var title = target.querySelector(".modal-title");
      if (dialog && title) title.id = dialog.id + "-title";
      var action = target.querySelector(".modal-foot .btn.primary");
      if (action) action.focus();
    }
  });

  // Live filter: hides items whose data-search lacks one of the typed words, and groups left empty.
  // Works inside the field's dialog or [data-filter-scope]: a group heading [data-filter-head="k"]
  // hides when no item [data-filter-group="k"] is left, [data-filter-empty] shows when nothing is.
  function filter(field) {
    var words = field.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    var scope = field.closest("dialog, [data-filter-scope]") || document;
    var shown = 0;
    scope.querySelectorAll(field.getAttribute("data-filter")).forEach(function (item) {
      var text = item.getAttribute("data-search") || "";
      var match = words.every(function (word) { return text.indexOf(word) !== -1; });
      item.hidden = !match;
      if (match) shown++;
    });
    scope.querySelectorAll(".switcher-org").forEach(function (group) {
      group.hidden = !group.querySelector(".switcher-item:not([hidden])");
    });
    scope.querySelectorAll("[data-filter-head]").forEach(function (head) {
      var key = head.getAttribute("data-filter-head");
      head.hidden = !Array.prototype.some.call(scope.querySelectorAll("[data-filter-group]"), function (item) {
        return item.getAttribute("data-filter-group") === key && !item.hidden;
      });
    });
    var empty = scope.querySelector(".switcher-empty, [data-filter-empty]");
    if (empty) empty.hidden = shown > 0;
  }

  document.addEventListener("input", function (event) {
    var field = event.target;
    if (field instanceof HTMLInputElement && field.hasAttribute("data-filter")) filter(field);
    if (field instanceof HTMLInputElement && field.hasAttribute("data-suggest")) {
      if (field.hasAttribute("data-suggest-picked")) field.removeAttribute("data-suggest-picked");
      else loadSuggest(field);
    }
  });

  // Enter in the filter field opens the first visible match.
  document.addEventListener("keydown", function (event) {
    var field = event.target;
    if ((event.key === "Enter" || event.key === " ") && field instanceof Element && field.matches("[data-detail-url]")) {
      event.preventDefault();
      openDetail(field);
      return;
    }
    if (field instanceof HTMLInputElement && field.hasAttribute("data-suggest") && suggestKey(field, event)) return;
    if (event.key === "Enter" && field instanceof HTMLInputElement && field.hasAttribute("data-filter")) {
      var first = document.querySelector(field.getAttribute("data-filter") + ":not([hidden])");
      if (first && first.href) {
        event.preventDefault();
        window.location.href = first.href;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      var switcher = document.getElementById("project-switcher");
      if (switcher && switcher.showModal && !switcher.open) {
        event.preventDefault();
        openDialog(switcher);
      }
    }
  });

  // Autocomplete: an input with data-suggest="<url>" loads {items: [{value, hint}], note} once per
  // URL and filters it while typing. data-suggest-with="index=src-index" adds the current value of
  // #src-index to the URL as ?index=…, so a field can depend on another one. The list is a manual
  // popover: it sits in the top layer above an open dialog and is never clipped by the dialog's
  // scroll area. Its position follows the field; the coordinates are set as custom properties.
  var canSuggest = typeof HTMLElement.prototype.showPopover === "function";
  var suggestCache = {};
  var MAX_SUGGESTIONS = 50;

  function suggestUrl(input) {
    var url = new URL(input.getAttribute("data-suggest"), window.location.href);
    (input.getAttribute("data-suggest-with") || "").split(/\s+/).forEach(function (pair) {
      var parts = pair.split("=");
      var source = parts[1] ? document.getElementById(parts[1]) : null;
      if (source) url.searchParams.set(parts[0], source.value.trim());
    });
    return url.pathname + url.search;
  }

  function suggestList(input) {
    var id = input.id + "-suggest";
    var list = document.getElementById(id);
    if (list) return list;
    list = document.createElement("ul");
    list.id = id;
    list.className = "suggest";
    list.setAttribute("role", "listbox");
    list.setAttribute("popover", "manual");
    input.insertAdjacentElement("afterend", list);
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", id);
    input.setAttribute("aria-expanded", "false");
    return list;
  }

  function suggestOwner(list) {
    return list && list.id ? document.querySelector('[aria-controls="' + list.id + '"]') : null;
  }

  function isOpen(list) {
    return !!list && canSuggest && list.matches(":popover-open");
  }

  function closeSuggest(input) {
    var list = document.getElementById(input.id + "-suggest");
    if (!list) return;
    if (isOpen(list)) list.hidePopover();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function placeSuggest(input, list) {
    var rect = input.getBoundingClientRect();
    var below = window.innerHeight - rect.bottom - 12;
    var above = rect.top - 12;
    var up = below < 180 && above > below;
    list.classList.toggle("above", up);
    list.style.setProperty("--suggest-left", rect.left + "px");
    list.style.setProperty("--suggest-width", rect.width + "px");
    list.style.setProperty("--suggest-top", rect.bottom + 4 + "px");
    list.style.setProperty("--suggest-bottom", window.innerHeight - rect.top + 4 + "px");
    list.style.setProperty("--suggest-max", Math.max(120, Math.min(320, up ? above : below)) + "px");
  }

  function suggestItem(list, i, item) {
    var li = document.createElement("li");
    li.id = list.id + "-" + i;
    li.className = "suggest-item";
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", "false");
    li.setAttribute("data-value", item.value);
    var value = document.createElement("span");
    value.className = "suggest-value";
    value.textContent = item.value;
    li.appendChild(value);
    if (item.hint) {
      var hint = document.createElement("span");
      hint.className = "suggest-hint";
      hint.textContent = item.hint;
      li.appendChild(hint);
    }
    return li;
  }

  // Matches at the start first, otherwise in the server's order; the field's own value is left out.
  function renderSuggest(input, data) {
    var list = suggestList(input);
    var typed = input.value.trim().toLowerCase();
    var needle = typed.replace(/\*+$/, "");
    var all = data.items || [];
    var hits = all.filter(function (item) {
      var value = item.value.toLowerCase();
      return value !== typed && (!needle || value.indexOf(needle) !== -1);
    });
    hits.sort(function (a, b) {
      return Number(b.value.toLowerCase().indexOf(needle) === 0) - Number(a.value.toLowerCase().indexOf(needle) === 0);
    });
    list.replaceChildren();
    hits.slice(0, MAX_SUGGESTIONS).forEach(function (item, i) { list.appendChild(suggestItem(list, i, item)); });
    if (all.length === 0 && data.note) {
      var note = document.createElement("li");
      note.className = "suggest-note";
      note.textContent = data.note;
      list.appendChild(note);
    }
    if (!list.children.length || document.activeElement !== input) return closeSuggest(input);
    placeSuggest(input, list);
    if (!isOpen(list)) list.showPopover();
    list.scrollTop = 0;
    input.setAttribute("aria-expanded", "true");
    input.removeAttribute("aria-activedescendant");
  }

  function loadSuggest(input) {
    if (!canSuggest) return;
    var url = suggestUrl(input);
    var entry = suggestCache[url];
    if (entry && entry.data) return renderSuggest(input, entry.data);
    if (entry) return;
    suggestCache[url] = {};
    fetch(url, { headers: { accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        suggestCache[url] = { data: data };
        if (document.activeElement === input && suggestUrl(input) === url) renderSuggest(input, data);
      })
      .catch(function () {
        delete suggestCache[url];
        if (document.activeElement === input) renderSuggest(input, { items: [], note: "Vorschläge sind gerade nicht abrufbar." });
      });
  }

  function moveSuggest(input, list, step) {
    var items = Array.prototype.slice.call(list.querySelectorAll(".suggest-item"));
    if (!items.length) return;
    var current = items.findIndex(function (li) { return li.getAttribute("aria-selected") === "true"; });
    var next = current === -1 ? (step > 0 ? 0 : items.length - 1) : (current + step + items.length) % items.length;
    items.forEach(function (li, i) { li.setAttribute("aria-selected", String(i === next)); });
    input.setAttribute("aria-activedescendant", items[next].id);
    items[next].scrollIntoView({ block: "nearest" });
  }

  // The synthetic input event lets htmx and dependent previews react; it must not reopen the list.
  function pickSuggest(input, li) {
    input.value = li.getAttribute("data-value");
    closeSuggest(input);
    input.setAttribute("data-suggest-picked", "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // Arrows open and move, Enter picks, Escape closes the list without closing the dialog.
  function suggestKey(input, event) {
    var list = document.getElementById(input.id + "-suggest");
    var open = isOpen(list);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (open) moveSuggest(input, list, event.key === "ArrowDown" ? 1 : -1);
      else loadSuggest(input);
      return true;
    }
    if (!open) return false;
    if (event.key === "Enter") {
      var active = list.querySelector('.suggest-item[aria-selected="true"]');
      if (!active) return false;
      event.preventDefault();
      pickSuggest(input, active);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeSuggest(input);
      return true;
    }
    return false;
  }

  function placeOpenSuggest() {
    if (!canSuggest) return;
    document.querySelectorAll(".suggest:popover-open").forEach(function (list) {
      var input = suggestOwner(list);
      if (input) placeSuggest(input, list);
    });
  }

  document.addEventListener("focusin", function (event) {
    var input = event.target;
    if (input instanceof HTMLInputElement && input.hasAttribute("data-suggest")) loadSuggest(input);
  });
  document.addEventListener("focusout", function (event) {
    var input = event.target;
    if (input instanceof HTMLInputElement && input.hasAttribute("data-suggest")) closeSuggest(input);
  });
  // A click on an option must not take the focus from the field before the click lands.
  document.addEventListener("mousedown", function (event) {
    if (event.target instanceof Element && event.target.closest(".suggest")) event.preventDefault();
  });
  window.addEventListener("resize", placeOpenSuggest);
  document.addEventListener("scroll", placeOpenSuggest, true);
  document.addEventListener("animationend", placeOpenSuggest, true);

  markTheme();
})();
