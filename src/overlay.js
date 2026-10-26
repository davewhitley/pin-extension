// Injected into the page on demand. Draws the crop selector and comment panel
// inside a shadow root so the host page's CSS can't reach in and break it.
//
// This script never sees the GitHub token or the screenshot bytes — it reports a
// rectangle and some metadata, and the service worker does the rest.

(() => {
  const FLAG = '__pin_overlay_installed__';
  if (window[FLAG]) return;
  window[FLAG] = true;

  const ACCENT = '#7C5CFF';
  const MIN_SIZE = 8; // px; smaller than this is a stray click, not a selection
  const STROKE_WIDTH = 3;
  // Red first: the convention for marking up a screenshot. White earns its place on
  // dark UI, where the other three disappear.
  const INKS = ['#FF3B30', '#FFCC00', '#0A84FF', '#FFFFFF'];

  let host = null;
  let ui = {};
  let state = 'idle'; // idle | dragging | composing | sending
  let anchor = null;
  let rect = null;
  let repoList = [];
  let currentRepo = '';
  let available = [];        // labels this repo has, from GitHub
  let chosen = new Set();    // label names on this report
  let canPush = true;        // false => GitHub will drop labels silently
  let cursor = 0;            // highlighted row in the popover
  let shot = '';             // the frozen image being cropped
  let mode = 'tab';          // 'tab' = viewport capture, 'image' = pasted file
  let imageBox = null;       // CSS-pixel rect the image occupies on screen
  let tip = null;            // { shortcut } when this capture began with a click
  let strokes = [];          // committed pencil strokes, in selection-relative CSS px
  let drawing = null;        // the stroke currently under the pointer
  let inkColor = '';         // chosen swatch
  let dupTimer = 0;          // debounce for the duplicate search
  let dupSeq = 0;            // guards a slow reply from overwriting a newer one

  // ------------------------------------------------------------- device info

  async function collectMeta() {
    const page = mode === 'tab';
    const meta = {
      // A pasted screenshot may not come from a web page at all — inventing a URL
      // would be worse than omitting one. environmentTable drops empty rows.
      url: page ? location.href : '',
      title: page ? document.title : '',
      source: '',
      viewport: page ? `${window.innerWidth} × ${window.innerHeight}` : '',
      screen: `${screen.width} × ${screen.height}${window.devicePixelRatio !== 1 ? ` @${window.devicePixelRatio}x` : ''}`,
      language: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      reportedAt: new Date().toISOString(),
      browser: '',
      os: '',
    };

    // userAgentData is structured and honest; the UA string is a last resort.
    const uad = navigator.userAgentData;
    if (uad) {
      try {
        const hi = await uad.getHighEntropyValues(['platformVersion', 'uaFullVersion', 'fullVersionList']);
        const real = (hi.fullVersionList || uad.brands || []).find((b) => !/not.?a.?brand/i.test(b.brand));
        if (real) meta.browser = `${real.brand} ${real.version}`;
        meta.os = [hi.platform || uad.platform, hi.platformVersion].filter(Boolean).join(' ').trim();
      } catch {
        const real = (uad.brands || []).find((b) => !/not.?a.?brand/i.test(b.brand));
        if (real) meta.browser = `${real.brand} ${real.version}`;
        meta.os = uad.platform || '';
      }
    }

    if (!meta.browser) {
      const m = navigator.userAgent.match(/(Chrome|Firefox|Safari|Edg)\/([\d.]+)/);
      meta.browser = m ? `${m[1]} ${m[2]}` : navigator.userAgent;
    }
    if (!meta.os) {
      const ua = navigator.userAgent;
      meta.os = /Mac/.test(ua) ? 'macOS' : /Win/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
    }
    return meta;
  }

  // ------------------------------------------------------------- shadow UI

  const CSS = `
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif; }

    /* The frozen capture. Everything above it dims; the selection cuts back to it. */
    .shot { position: fixed; background-repeat: no-repeat; background-size: 100% 100%; }
    .backdrop { position: fixed; inset: 0; background: #0f1115; }
    .dim { position: fixed; inset: 0; background: rgba(15,17,21,.38); cursor: crosshair; }

    .sel {
      position: fixed; display: none; border-radius: 3px;
      outline: 2px solid ${ACCENT};
      box-shadow: 0 0 0 100vmax rgba(15,17,21,.38);
      pointer-events: none;
    }

    .hint {
      position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
      background: rgba(20,22,28,.92); color: #fff; font-size: 13px; line-height: 1;
      padding: 10px 14px; border-radius: 999px; white-space: nowrap;
      box-shadow: 0 6px 24px rgba(0,0,0,.35); pointer-events: none;
    }
    /* The pill ignores pointer events so it never eats a drag; the link opts back in. */
    .hint button {
      all: unset; pointer-events: auto; cursor: pointer;
      color: #a99bff; text-decoration: underline; text-underline-offset: 2px;
    }
    .hint button:hover { color: #c4b9ff; }
    .hint .sep { opacity: .4; margin: 0 8px; }

    .hint kbd {
      font-family: ui-monospace, monospace; font-size: 11px; background: rgba(255,255,255,.16);
      border-radius: 4px; padding: 2px 5px; margin: 0 2px;
    }

    .draw { position: fixed; display: none; touch-action: none; }

    .tools {
      position: fixed; display: none; align-items: center; gap: 6px;
      padding: 6px 8px; border-radius: 999px; background: rgba(20,22,28,.92);
      box-shadow: 0 6px 20px rgba(0,0,0,.34);
    }
    /* Floating over the screenshot rather than beside it — needs to read as lifted. */
    .tools.inside {
      background: rgba(20,22,28,.96);
      box-shadow: 0 8px 28px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.10);
    }

    .swatch {
      width: 16px; height: 16px; border-radius: 50%; padding: 0; cursor: pointer;
      border: 2px solid transparent; box-shadow: inset 0 0 0 1px rgba(0,0,0,.28);
    }
    .swatch[aria-pressed="true"] { border-color: #fff; }
    .tools .sep { width: 1px; height: 16px; background: rgba(255,255,255,.18); }
    .tools .act {
      all: unset; cursor: pointer; color: #c8cbd4; font-size: 11.5px; line-height: 1;
      padding: 4px 7px; border-radius: 6px;
    }
    .tools .act:hover:not([disabled]) { background: rgba(255,255,255,.12); color: #fff; }
    .tools .act[disabled] { opacity: .38; cursor: default; }

    .tip {
      position: fixed; top: 56px; left: 50%; transform: translateX(-50%);
      display: none; align-items: center; gap: 4px;
      background: rgba(20,22,28,.78); color: #c8cbd4; font-size: 11.5px; line-height: 1;
      padding: 7px 12px; border-radius: 999px; white-space: nowrap;
    }
    .tip kbd {
      font-family: ui-monospace, monospace; font-size: 11px; color: #fff;
      background: rgba(255,255,255,.16); border-radius: 4px; padding: 2px 5px;
    }
    .tip button { all: unset; cursor: pointer; color: #a99bff; text-decoration: underline; }
    .tip button:hover { color: #c4b9ff; }

    .panel {
      position: fixed; display: none; width: 340px; padding: 14px;
      background: #fff; color: #14161c; border-radius: 12px;
      box-shadow: 0 18px 48px rgba(0,0,0,.28), 0 0 0 1px rgba(0,0,0,.06);
    }
    .panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .panel-head b { font-size: 13px; font-weight: 600; }
    .panel-head select {
      font-size: 11px; font-family: ui-monospace, monospace; color: #6b7280;
      background: transparent; border: 1px solid #d8dae0; border-radius: 6px;
      padding: 3px 6px; max-width: 200px; cursor: pointer; outline: none;
    }
    .panel-head select:focus { border-color: ${ACCENT}; box-shadow: 0 0 0 3px rgba(124,92,255,.18); }

    input.title {
      width: 100%; padding: 5px 2px 7px; margin-bottom: 9px;
      font-size: 14px; font-weight: 600; color: inherit;
      background: transparent; border: none; border-bottom: 1px solid #d8dae0;
      border-radius: 0; outline: none;
    }
    /* inset shadow thickens the rule on focus without nudging the layout */
    input.title:focus { border-bottom-color: ${ACCENT}; box-shadow: inset 0 -2px 0 -1px ${ACCENT}; }
    input.title::placeholder { font-weight: 400; color: #9aa1ad; }

    input.source {
      display: none; width: 100%; padding: 6px 8px; margin-bottom: 8px;
      font-size: 11.5px; color: inherit; background: transparent;
      border: 1px solid #d8dae0; border-radius: 7px; outline: none;
    }
    input.source:focus { border-color: ${ACCENT}; box-shadow: 0 0 0 3px rgba(124,92,255,.18); }
    input.title.derived::placeholder { font-style: italic; }

    .dupes { display: none; margin: -2px 0 8px; font-size: 11.5px; color: #6b7280; }
    .dupes summary { cursor: pointer; list-style: none; }
    .dupes summary::-webkit-details-marker { display: none; }
    .dupes summary::before { content: '▸ '; }
    .dupes[open] summary::before { content: '▾ '; }
    .dupes a {
      display: block; color: inherit; text-decoration: none; padding: 3px 0 3px 12px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .dupes a:hover { color: ${ACCENT}; text-decoration: underline; }
    .dupes a b { font-weight: 500; opacity: .7; }

    textarea {
      width: 100%; height: 80px; resize: vertical; overscroll-behavior: contain; padding: 9px 10px;
      font-size: 13px; line-height: 1.45; color: inherit;
      border: 1px solid #d8dae0; border-radius: 8px; background: #fff; outline: none;
    }
    textarea:focus { border-color: ${ACCENT}; box-shadow: 0 0 0 3px rgba(124,92,255,.18); }

    .labels { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin-top: 9px; }

    .chip {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 11.5px; line-height: 1; padding: 4px 5px 4px 7px; border-radius: 999px;
      background: rgba(var(--rgb), .14); border: 1px solid rgba(var(--ink), .5); color: inherit;
    }
    .chip i { width: 7px; height: 7px; border-radius: 50%; background: rgb(var(--ink)); flex: none; }
    .chip button {
      all: unset; cursor: pointer; font-size: 13px; line-height: 1;
      padding: 0 1px; color: #6b7280; border-radius: 3px;
    }
    .chip button:hover { color: #b4232a; }

    .add-label {
      font-size: 11.5px; font-weight: 500; padding: 4px 9px; border-radius: 999px;
      background: transparent; color: #6b7280; border: 1px dashed #c9ccd4;
    }
    .add-label:hover:not(:disabled) { color: ${ACCENT}; border-color: ${ACCENT}; }
    .no-push { font-size: 11px; color: #9aa1ad; width: 100%; }

    .pop {
      position: absolute; display: none; width: 258px; z-index: 2;
      background: #fff; border-radius: 10px; overflow: hidden;
      box-shadow: 0 12px 32px rgba(0,0,0,.22), 0 0 0 1px rgba(0,0,0,.08);
    }
    .pop input {
      width: 100%; border: none; border-bottom: 1px solid #e6e8ec; border-radius: 0;
      padding: 9px 11px; font-size: 12.5px; background: transparent; color: inherit; outline: none;
    }
    .pop .list { max-height: 232px; overflow-y: auto; overscroll-behavior: contain; padding: 4px; }
    .pop .opt {
      display: flex; align-items: center; gap: 7px; width: 100%;
      padding: 6px 7px; border-radius: 6px; cursor: pointer; font-size: 12px; text-align: left;
      background: transparent; border: none; color: inherit;
    }
    .pop .opt.active { background: #f0f1f4; }
    .pop .opt i { width: 9px; height: 9px; border-radius: 50%; background: rgb(var(--ink)); flex: none; }
    .pop .opt .tick { width: 11px; flex: none; color: ${ACCENT}; font-size: 11px; }
    .pop .opt .name { font-weight: 500; white-space: nowrap; }
    .pop .opt .desc {
      color: #9aa1ad; font-size: 11px; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;
    }
    .pop .none { padding: 12px; font-size: 12px; color: #9aa1ad; text-align: center; }

    details { margin-top: 10px; font-size: 11.5px; color: #6b7280; }
    summary { cursor: pointer; user-select: none; }
    dl { margin-top: 7px; display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; }
    dt { color: #9aa1ad; }
    dd { color: #4b5260; overflow-wrap: anywhere; }

    .row { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
    .spacer { flex: 1; }

    button {
      font-size: 13px; font-weight: 500; padding: 8px 14px;
      border-radius: 8px; border: 1px solid transparent; cursor: pointer;
    }
    .ghost { background: transparent; color: #6b7280; }
    .ghost:hover { background: #f2f3f5; }
    .primary { background: ${ACCENT}; color: #fff; }
    .primary:hover { filter: brightness(1.07); }
    button:disabled { opacity: .55; cursor: default; filter: none; }

    .msg { margin-top: 10px; font-size: 12px; line-height: 1.45; display: none; overflow-wrap: anywhere; }
    .msg.error { display: block; color: #b4232a; }
    .msg.success { display: block; color: #1a7f47; }
    .msg a { color: inherit; font-weight: 600; }

    @media (prefers-color-scheme: dark) {
      .panel { background: #1b1d23; color: #eceef2; box-shadow: 0 18px 48px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.08); }
      textarea, input.source { background: #23262e; border-color: #363a45; }
      input.title { border-bottom-color: #363a45; }
      .ghost:hover { background: #2a2d36; }
      .panel-head select { border-color: #363a45; color: #9aa1ad; }
      dd { color: #b9c0cc; }
      .chip { border-color: rgba(var(--ink-d), .5); }
      .chip i, .pop .opt i { background: rgb(var(--ink-d)); }
      .add-label { border-color: #40444f; }
      .pop { background: #23262e; box-shadow: 0 12px 32px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.09); }
      .pop input { border-bottom-color: #363a45; }
      .pop .opt.active { background: #2f333d; }
      .msg.error { color: #ff8087; }
      .msg.success { color: #5fd396; }
    }
  `;

  function build() {
    host = document.createElement('div');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="backdrop"></div>
      <div class="shot"></div>
      <div class="dim"></div>
      <div class="sel"></div>
      <div class="hint">Drag to select an area <span class="sep">·</span> <kbd>Esc</kbd> to cancel<span
        class="sep upload-sep">·</span><button class="upload"
        title="For native dropdowns, another app, or a screenshot you already took">Upload an image instead</button></div>
      <div class="tip"></div>
      <canvas class="draw"></canvas>
      <div class="tools"></div>
      <div class="panel">
        <div class="panel-head"><b>Report a bug</b><select class="repo" title="Where to file this"></select></div>
        <input class="source" type="text" placeholder="URL or context (optional)" spellcheck="false">
        <input class="title" type="text" maxlength="256" placeholder="Title"
               title="Leave blank to use the first line of the description">
        <details class="dupes"><summary></summary><div class="dupe-list"></div></details>
        <textarea placeholder="What's wrong here?"></textarea>
        <div class="labels"><button class="add-label">+ Label</button></div>
        <div class="pop">
          <input type="text" placeholder="Filter labels…" spellcheck="false">
          <div class="list"></div>
        </div>
        <details>
          <summary>Device info to include</summary>
          <dl></dl>
        </details>
        <div class="row">
          <button class="ghost cancel">Cancel</button>
          <div class="spacer"></div>
          <button class="primary send">Create issue</button>
        </div>
        <div class="msg"></div>
      </div>
    `;
    // documentElement, not body — survives pages that rewrite body.
    document.documentElement.appendChild(host);

    ui = {
      backdrop: shadow.querySelector('.backdrop'),
      shot: shadow.querySelector('.shot'),
      dim: shadow.querySelector('.dim'),
      sel: shadow.querySelector('.sel'),
      hint: shadow.querySelector('.hint'),
      upload: shadow.querySelector('.upload'),
      uploadSep: shadow.querySelector('.upload-sep'),
      tip: shadow.querySelector('.tip'),
      draw: shadow.querySelector('canvas.draw'),
      tools: shadow.querySelector('.tools'),
      panel: shadow.querySelector('.panel'),
      repo: shadow.querySelector('.repo'),
      source: shadow.querySelector('input.source'),
      title: shadow.querySelector('input.title'),
      dupes: shadow.querySelector('.dupes'),
      dupeList: shadow.querySelector('.dupe-list'),
      textarea: shadow.querySelector('textarea'),
      labels: shadow.querySelector('.labels'),
      addLabel: shadow.querySelector('.add-label'),
      pop: shadow.querySelector('.pop'),
      popInput: shadow.querySelector('.pop input'),
      popList: shadow.querySelector('.pop .list'),
      meta: shadow.querySelector('dl'),
      cancel: shadow.querySelector('.cancel'),
      send: shadow.querySelector('.send'),
      msg: shadow.querySelector('.msg'),
    };

    ui.dim.addEventListener('pointerdown', onPointerDown);
    wireDrawing();

    ui.upload.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'PIN_PASTE_VIEW' }).catch(() => {});
      close(true); // the capture is abandoned; the paste view takes over
    });
    ui.panel.addEventListener('pointerdown', (e) => {
      if (ui.pop.style.display !== 'block') return;
      const path = e.composedPath();
      if (!path.includes(ui.pop) && !path.includes(ui.addLabel)) closePopover();
    });
    ui.cancel.addEventListener('click', () => close(true));
    ui.repo.addEventListener('change', () => {
      currentRepo = ui.repo.value;
      closePopover();
      loadLabels();          // each repo has its own labels and defaults...
      hideDupes();
      queueDuplicateCheck(); // ...and its own issues
    });
    ui.addLabel.addEventListener('click', togglePopover);
    ui.popInput.addEventListener('input', () => { cursor = 0; renderOptions(); });
    ui.popInput.addEventListener('keydown', onPopoverKey);
    ui.send.addEventListener('click', submit);
    ui.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    });
    ui.title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); return; }
      if (e.key === 'Enter') { e.preventDefault(); ui.textarea.focus(); }
    });
    // Show what the title will be if left blank, so the fallback is never a surprise.
    ui.textarea.addEventListener('input', syncTitlePlaceholder);
    ui.title.addEventListener('input', queueDuplicateCheck);
    // Expanding the disclosure changes the panel's height, which can push it off
    // the bottom of the viewport when the selection sits low on the page.
    shadow.querySelector('details:not(.dupes)').addEventListener('toggle', () => { if (rect) position(); });
    window.addEventListener('keydown', onKeyDown, true);
    // The screenshot is already frozen, so scrolling the page would only desync what
    // you see — but the panel has its own scrollable regions (the label list, a long
    // description) that must still respond to the wheel.
    host.addEventListener('wheel', (e) => {
      if (!scrollableInPath(e)) e.preventDefault();
    }, { passive: false });

    // Nothing typed or clicked in the panel should reach the page. Shadow DOM
    // retargets events, so a site's hotkey handler sees `event.target` as this host
    // <div> rather than an <input> — the usual "ignore keystrokes while the user is
    // typing" guard never fires, and a single-letter shortcut (n, /, g, ?) steals
    // focus mid-word. Stopping at the host is safe on both counts: our own handlers
    // live inside the shadow tree and run first, and the Escape handler above is on
    // window in the capture phase, which runs before the event ever reaches here.
    const SEALED = [
      'keydown', 'keyup', 'keypress',
      'mousedown', 'mouseup', 'click', 'dblclick',
      'pointerdown', 'pointerup', 'contextmenu', 'wheel',
    ];
    for (const type of SEALED) host.addEventListener(type, (e) => e.stopPropagation());
  }

  function close(notifyWorker) {
    window.removeEventListener('keydown', onKeyDown, true);
    host?.remove();
    host = null;
    ui = {};
    state = 'idle';
    rect = null;
    anchor = null;
    available = [];
    chosen = new Set();
    imageBox = null;
    shot = '';
    tip = null;
    strokes = [];
    drawing = null;
    inkColor = INKS[0];
    clearTimeout(dupTimer);
    dupSeq++; // any in-flight search reply is now stale
    if (notifyWorker) chrome.runtime.sendMessage({ type: 'PIN_CANCEL' }).catch(() => {});
  }

  function onKeyDown(e) {
    if (e.key !== 'Escape' || state === 'sending') return;
    e.preventDefault();
    e.stopPropagation();
    // One Escape backs out of the picker; a second cancels the report.
    if (ui.pop && ui.pop.style.display === 'block') { closePopover(); return; }
    close(true);
  }

  // ------------------------------------------------------------- selection

  function onPointerDown(e) {
    if (state !== 'idle' || e.button !== 0) return;
    state = 'dragging';
    anchor = clampToImage({ x: e.clientX, y: e.clientY });
    ui.dim.setPointerCapture(e.pointerId);
    ui.dim.addEventListener('pointermove', onPointerMove);
    ui.dim.addEventListener('pointerup', onPointerUp);
    // Swap the flat dim for the cut-out dim produced by .sel's huge box-shadow.
    ui.dim.style.background = 'transparent';
    ui.sel.style.display = 'block';
    paint({ x: anchor.x, y: anchor.y, w: 0, h: 0 });
  }

  function onPointerMove(e) {
    if (state !== 'dragging') return;
    paint(rectFrom(anchor, clampToImage({ x: e.clientX, y: e.clientY })));
  }

  async function onPointerUp(e) {
    if (state !== 'dragging') return;
    ui.dim.removeEventListener('pointermove', onPointerMove);
    ui.dim.removeEventListener('pointerup', onPointerUp);

    const r = rectFrom(anchor, clampToImage({ x: e.clientX, y: e.clientY }));
    if (r.w < MIN_SIZE || r.h < MIN_SIZE) {
      // Treat a click or a stray flick as "start over" rather than an error.
      state = 'idle';
      ui.sel.style.display = 'none';
      ui.dim.style.background = 'rgba(15,17,21,.38)';
      return;
    }

    rect = r;
    state = 'composing';
    ui.hint.style.display = 'none';
    ui.tip.style.display = 'none';
    ui.dim.style.cursor = 'default';

    const res = await chrome.runtime.sendMessage({ type: 'PIN_CROP', rect, imageBox })
      .catch((err) => ({ ok: false, error: String(err?.message || err) }));

    if (!host) return; // cancelled while the crop was in flight
    if (!res?.ok) { showError(res?.error || 'Could not crop the screenshot.'); return; }

    startMarkup();
    await openPanel();
  }

  /** Mirrors titleFrom() in the service worker — keep the two in step. */
  function derivedTitle() {
    const first = ui.textarea.value.trim().split('\n')[0].trim();
    if (!first) return '';
    return first.length > 70 ? `${first.slice(0, 69)}…` : first;
  }

  function syncTitlePlaceholder() {
    const derived = derivedTitle();
    ui.title.placeholder = derived || 'Title';
    ui.title.classList.toggle('derived', !!derived);
  }

  function rectFrom(a, b) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(a.x - b.x),
      h: Math.abs(a.y - b.y),
    };
  }

  function paint(r) {
    rect = r;
    Object.assign(ui.sel.style, {
      left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`,
    });
  }

  // ------------------------------------------------------------- duplicates

  /**
   * Surfaces open issues that already say this. Debounced because a title is typed
   * a character at a time and GitHub's search API allows 30 requests a minute.
   *
   * Advisory by design — it never blocks the report. The moment worth catching a
   * duplicate is while the title is still being written, not in a dialog after the
   * person has already decided to file.
   */
  function queueDuplicateCheck() {
    clearTimeout(dupTimer);
    const text = ui.title.value.trim();
    if (text.length < 6) { hideDupes(); return; }
    dupTimer = setTimeout(() => runDuplicateCheck(text), 600);
  }

  /** GitHub numbers issues; Linear names them. "#ENG-140" is nobody's convention. */
  const refOf = (n) => (/^\d+$/.test(String(n)) ? `#${n}` : String(n));

  function hideDupes() {
    if (!ui.dupes) return;
    ui.dupes.style.display = 'none';
    ui.dupes.open = false;
    ui.dupeList.innerHTML = '';
  }

  async function runDuplicateCheck(text) {
    const seq = ++dupSeq;
    const res = await chrome.runtime.sendMessage({
      type: 'PIN_SEARCH', repoSlug: ui.repo.value, text,
    }).catch(() => null);

    // A reply for an older keystroke must never replace a newer one.
    if (!host || seq !== dupSeq) return;

    const issues = res?.issues || [];
    if (!issues.length) { hideDupes(); return; }

    ui.dupeList.innerHTML = '';
    for (const issue of issues) {
      const a = document.createElement('a');
      a.href = issue.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.title = issue.title;
      const n = document.createElement('b');
      n.textContent = `${refOf(issue.number)} `;
      a.append(n, document.createTextNode(issue.title));
      ui.dupeList.append(a);
    }

    ui.dupes.querySelector('summary').textContent =
      `${issues.length} similar open issue${issues.length === 1 ? '' : 's'}`;
    ui.dupes.style.display = 'block';
    position();
  }

  // ------------------------------------------------------------- markup

  const dpr = () => window.devicePixelRatio || 1;
  const pointIn = (e) => ({ x: e.clientX - rect.x, y: e.clientY - rect.y });

  /**
   * A pencil in the current ink, so the cursor names the tool and the colour at once —
   * crosshair is the crop cursor and said nothing about drawing. Double outlined, dark
   * under white, because a cursor has to stay legible over an arbitrary screenshot:
   * the white keeps it visible on dark UI, the dark keeps white ink visible on light.
   * The hotspot is the tip at (3, 21).
   */
  function pencilCursor(color) {
    const d = 'M2.5 21.5 L4.3 16.2 L16.8 3.7 L20.3 7.2 L7.8 19.7 Z';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">`
      + `<g stroke-linejoin="round" stroke-linecap="round">`
      + `<path d="${d}" fill="none" stroke="#000" stroke-opacity=".55" stroke-width="3.6"/>`
      + `<path d="${d}" fill="${color}" stroke="#fff" stroke-width="1.7"/>`
      + `<path d="M4.3 16.2 L7.8 19.7" fill="none" stroke="#fff" stroke-width="1.2" stroke-opacity=".85"/>`
      + `</g></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 3 21, crosshair`;
  }

  /**
   * Draws one stroke. Quadratic segments through the midpoints turn the raw pointer
   * samples into a smooth line — joining them with straight segments looks visibly
   * faceted at this stroke width. Mirrored in the service worker, which redraws these
   * same strokes onto the full-resolution crop at submit time.
   */
  function strokePath(ctx, s) {
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (s.points.length === 1) { // a tap, not a drag
      ctx.beginPath();
      ctx.arc(s.points[0].x, s.points[0].y, s.width / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length - 1; i++) {
      const mx = (s.points[i].x + s.points[i + 1].x) / 2;
      const my = (s.points[i].y + s.points[i + 1].y) / 2;
      ctx.quadraticCurveTo(s.points[i].x, s.points[i].y, mx, my);
    }
    const last = s.points[s.points.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }

  function redraw() {
    const ctx = ui.draw.getContext('2d');
    const k = dpr();
    ctx.setTransform(k, 0, 0, k, 0, 0); // never accumulate across redraws
    ctx.clearRect(0, 0, rect.w, rect.h);
    for (const s of strokes) strokePath(ctx, s);
    if (drawing) strokePath(ctx, drawing);
  }

  /** Sizes the canvas to the selection, backed at device resolution so it is crisp. */
  function startMarkup() {
    const k = dpr();
    ui.draw.width = Math.round(rect.w * k);
    ui.draw.height = Math.round(rect.h * k);
    Object.assign(ui.draw.style, {
      display: 'block',
      left: `${rect.x}px`, top: `${rect.y}px`,
      width: `${rect.w}px`, height: `${rect.h}px`,
    });
    redraw();
    renderTools();
  }

  function applyCursor() {
    ui.draw.style.cursor = pencilCursor(inkColor);
  }

  function renderTools() {
    ui.tools.innerHTML = '';

    for (const color of INKS) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = color;
      b.title = 'Pencil colour';
      b.setAttribute('aria-pressed', String(color === inkColor));
      b.addEventListener('click', () => { inkColor = color; renderTools(); });
      ui.tools.append(b);
    }

    const sep = document.createElement('div');
    sep.className = 'sep';
    ui.tools.append(sep);

    const undo = document.createElement('button');
    undo.className = 'act';
    undo.textContent = 'Undo';
    undo.disabled = strokes.length === 0;
    undo.addEventListener('click', () => { strokes.pop(); redraw(); renderTools(); });

    const clear = document.createElement('button');
    clear.className = 'act';
    clear.textContent = 'Clear';
    clear.disabled = strokes.length === 0;
    clear.addEventListener('click', () => { strokes = []; redraw(); renderTools(); });

    ui.tools.append(undo, clear);
    ui.tools.style.display = 'flex';
    positionTools();
    applyCursor(); // the ink may have just changed
  }

  /**
   * Above the selection, else below it, else floating just inside its top-left.
   *
   * The third case is what a near-fullscreen selection needs: with no room on
   * either edge, clamping to the viewport used to pin the toolbar to the very
   * bottom of the screen — visually clipped, and nowhere near what was being
   * drawn. Inside the selection it is always fully visible and always close to
   * the work, which is the point of a floating toolbar.
   */
  function positionTools() {
    const GAP = 8, INSET = 12;
    const h = ui.tools.offsetHeight || 32;
    const w = ui.tools.offsetWidth || 190;
    const W = window.innerWidth, H = window.innerHeight;

    const clampX = (x) => Math.max(GAP, Math.min(x, W - w - GAP));
    const fitsAbove = rect.y - GAP - h >= GAP;
    const fitsBelow = rect.y + rect.h + GAP + h <= H - GAP;

    let top;
    let left = clampX(rect.x);
    let inside = false;

    if (fitsAbove) {
      top = rect.y - GAP - h;
    } else if (fitsBelow) {
      top = rect.y + rect.h + GAP;
    } else {
      inside = true;
      top = Math.max(GAP, Math.min(rect.y + INSET, H - h - GAP));
      left = clampX(rect.x + INSET);
    }

    ui.tools.classList.toggle('inside', inside);
    ui.tools.style.top = `${top}px`;
    ui.tools.style.left = `${left}px`;
  }

  function wireDrawing() {
    ui.draw.addEventListener('pointerdown', (e) => {
      if (state !== 'composing' || e.button !== 0) return;
      e.preventDefault();
      ui.draw.setPointerCapture(e.pointerId);
      drawing = { color: inkColor, width: STROKE_WIDTH, points: [pointIn(e)] };
      redraw();
    });

    ui.draw.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const p = pointIn(e);
      const last = drawing.points[drawing.points.length - 1];
      // Drop samples closer than a pixel; they add nothing and cost smoothing quality.
      if (Math.hypot(p.x - last.x, p.y - last.y) < 1) return;
      drawing.points.push(p);
      redraw();
    });

    const finish = () => {
      if (!drawing) return;
      strokes.push(drawing);
      drawing = null;
      redraw();
      renderTools();
    };
    ui.draw.addEventListener('pointerup', finish);
    ui.draw.addEventListener('pointercancel', finish);
  }

  // ------------------------------------------------------------- shortcut tip

  const IS_MAC = /Mac/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);
  const SYMBOLS = { Command: '⌘', Ctrl: '⌃', Control: '⌃', MacCtrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧' };

  /** Chrome hands back either "Alt+Shift+B" or an already-symbolised string. */
  function prettyShortcut(s) {
    if (!s) return '';
    if (!IS_MAC || !s.includes('+')) return s;
    return s.split('+').map((part) => SYMBOLS[part] || part).join('');
  }

  /**
   * Shown only when the capture began with a click on the toolbar icon — that is
   * the gesture that just destroyed any hover state or open menu, and the only
   * time the advice is worth anything.
   */
  function renderTip() {
    if (!tip || mode !== 'tab') return;
    ui.tip.innerHTML = '';
    ui.tip.style.display = 'flex';

    const label = prettyShortcut(tip.shortcut);
    if (label) {
      ui.tip.append(document.createTextNode('Next time press '));
      const kbd = document.createElement('kbd');
      kbd.textContent = label;
      ui.tip.append(kbd, document.createTextNode(' to keep hover states and open menus'));
      return;
    }

    // No binding at all — the advice is useless without one, so offer the fix.
    ui.tip.append(document.createTextNode('A keyboard shortcut keeps hover states and open menus — '));
    const link = document.createElement('button');
    link.textContent = 'assign one';
    link.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'PIN_SHORTCUTS' }).catch(() => {});
      close(true);
    });
    ui.tip.append(link);
  }

  // ------------------------------------------------------------- backdrop

  /**
   * Where the frozen image is drawn, in CSS pixels.
   *
   * A tab capture is the viewport by definition, so it fills it exactly. A pasted
   * image has its own aspect ratio and is letterboxed, which is why every crop
   * coordinate has to be offset by this box rather than by the viewport origin.
   */
  function fitImage(naturalW, naturalH) {
    if (mode === 'tab') return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };

    const PAD = 24;
    const maxW = Math.max(1, window.innerWidth - PAD * 2);
    const maxH = Math.max(1, window.innerHeight - PAD * 2);
    // Never upscale — a small screenshot shown at 1:1 stays crisp and truthful.
    const scale = Math.min(1, maxW / naturalW, maxH / naturalH);
    const w = Math.round(naturalW * scale);
    const h = Math.round(naturalH * scale);
    return { x: Math.round((window.innerWidth - w) / 2), y: Math.round((window.innerHeight - h) / 2), w, h };
  }

  async function paintBackdrop() {
    // A tab capture's box is the viewport by definition — set it now, so a drag that
    // starts before the (large) data URL finishes decoding still crops correctly.
    if (mode === 'tab') imageBox = fitImage(1, 1);
    if (!shot) { imageBox = fitImage(1, 1); return; }

    const natural = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = shot;
    });
    if (!host) return;

    imageBox = natural ? fitImage(natural.w, natural.h) : fitImage(window.innerWidth, window.innerHeight);

    Object.assign(ui.shot.style, {
      left: `${imageBox.x}px`, top: `${imageBox.y}px`,
      width: `${imageBox.w}px`, height: `${imageBox.h}px`,
      backgroundImage: `url("${shot}")`,
    });
    // Only a pasted image has margins worth filling; a tab capture covers everything.
    ui.backdrop.style.display = mode === 'image' ? 'block' : 'none';
  }

  /**
   * True when the wheel is over something of ours that can actually scroll, walking
   * up only as far as the host. Paired with `overscroll-behavior: contain` in the
   * CSS, so reaching the end of a list never chains through to the page.
   */
  function scrollableInPath(e) {
    for (const el of e.composedPath()) {
      if (el === host) break;
      if (!(el instanceof HTMLElement)) continue;
      const overflowY = getComputedStyle(el).overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return true;
    }
    return false;
  }

  /** Keeps a selection inside the image — you cannot crop what was not captured. */
  function clampToImage(p) {
    if (!imageBox) return p;
    return {
      x: Math.min(Math.max(p.x, imageBox.x), imageBox.x + imageBox.w),
      y: Math.min(Math.max(p.y, imageBox.y), imageBox.y + imageBox.h),
    };
  }

  // ------------------------------------------------------------- labels

  /** "d73a4a" -> "215, 58, 74" so one value drives the dot, tint, and border. */
  function rgbOf(hex) {
    const h = String(hex || '').replace('#', '').padEnd(6, '0');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0).join(', ');
  }

  /**
   * GitHub allows pure white (`wontfix`) and near-black label colors, which vanish
   * against one theme or the other. Nudge only the extremes, per theme, so the dot
   * and border stay visible without losing the label's identity.
   */
  function ink(rgb, theme) {
    const [r, g, b] = rgb.split(',').map(Number);
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (theme === 'light' && lum > 0.82) return [r, g, b].map((v) => Math.round(v * 0.55)).join(', ');
    if (theme === 'dark' && lum < 0.18) return [r, g, b].map((v) => Math.round(v + (255 - v) * 0.5)).join(', ');
    return rgb;
  }

  /** Sets the three custom properties every coloured chip and option row needs. */
  function paintColor(el, hex) {
    const rgb = rgbOf(hex);
    el.style.setProperty('--rgb', rgb);
    el.style.setProperty('--ink', ink(rgb, 'light'));
    el.style.setProperty('--ink-d', ink(rgb, 'dark'));
  }

  async function loadLabels() {
    available = [];
    chosen = new Set();
    canPush = true;
    renderChips();

    const res = await chrome.runtime.sendMessage({ type: 'PIN_LABELS', repoSlug: currentRepo })
      .catch((err) => ({ ok: false, error: String(err?.message || err) }));

    if (!host || currentRepo !== ui.repo.value) return; // switched again mid-flight
    if (!res?.ok) { renderChips(); return; }            // picking is optional; fail quiet

    available = res.labels || [];
    canPush = res.canPush !== false;
    // Only pre-select defaults the repo actually still has.
    const names = new Set(available.map((l) => l.name));
    chosen = new Set((res.defaults || []).filter((n) => names.has(n)));
    renderChips();
  }

  function renderChips() {
    ui.labels.innerHTML = '';

    for (const name of chosen) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      paintColor(chip, available.find((l) => l.name === name)?.color);

      const dot = document.createElement('i');
      const text = document.createTextNode(name);
      const x = document.createElement('button');
      x.textContent = '×';
      x.title = `Remove ${name}`;
      x.addEventListener('click', () => { chosen.delete(name); renderChips(); });

      chip.append(dot, text, x);
      ui.labels.append(chip);
    }

    ui.labels.append(ui.addLabel);
    ui.addLabel.disabled = !canPush || available.length === 0;
    ui.addLabel.textContent = chosen.size ? '+' : '+ Label';

    if (!canPush) {
      const note = document.createElement('div');
      note.className = 'no-push';
      note.textContent = 'No push access — GitHub drops labels on this repo.';
      ui.labels.append(note);
    }
    if (rect) position();
  }

  function matching() {
    const q = ui.popInput.value.trim().toLowerCase();
    if (!q) return available;
    return available.filter((l) =>
      l.name.toLowerCase().includes(q) || (l.description || '').toLowerCase().includes(q));
  }

  function renderOptions() {
    const rows = matching();
    ui.popList.innerHTML = '';

    if (!rows.length) {
      const none = document.createElement('div');
      none.className = 'none';
      none.textContent = 'No matching labels';
      ui.popList.append(none);
      return;
    }

    cursor = Math.max(0, Math.min(cursor, rows.length - 1));

    rows.forEach((l, i) => {
      const opt = document.createElement('button');
      opt.className = `opt${i === cursor ? ' active' : ''}`;
      paintColor(opt, l.color);

      const tick = document.createElement('span');
      tick.className = 'tick';
      tick.textContent = chosen.has(l.name) ? '✓' : '';

      const dot = document.createElement('i');

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = l.name;

      opt.append(tick, dot, name);
      if (l.description) {
        const desc = document.createElement('span');
        desc.className = 'desc';
        desc.textContent = l.description;
        opt.append(desc);
      }

      opt.addEventListener('mousemove', () => {
        if (cursor === i) return;
        cursor = i;
        renderOptions();
      });
      opt.addEventListener('click', () => toggleLabel(l.name));
      ui.popList.append(opt);
    });

    const active = ui.popList.querySelector('.opt.active');
    active?.scrollIntoView({ block: 'nearest' });
  }

  function toggleLabel(name) {
    if (chosen.has(name)) chosen.delete(name); else chosen.add(name);
    renderChips();
    renderOptions();      // keep the popover open for picking several in a row
    ui.popInput.focus();
  }

  function togglePopover() {
    if (ui.pop.style.display === 'block') { closePopover(); return; }
    ui.popInput.value = '';
    cursor = 0;
    renderOptions();
    ui.pop.style.display = 'block';
    positionPopover();
    ui.popInput.focus();
  }

  function closePopover() {
    ui.pop.style.display = 'none';
  }

  /**
   * Sits outside the panel — below it when there is room, otherwise above — so the
   * title and description stay visible while you pick. Anchoring to the + button
   * instead means that on a low selection the popover flips up and covers the whole
   * form, which reads as the panel vanishing.
   */
  function positionPopover() {
    const GAP = 6, EDGE = 8, MIN = 132, MAX = 266, CHROME = 37; // CHROME ≈ filter input
    const panel = ui.panel.getBoundingClientRect();

    const below = window.innerHeight - panel.bottom - GAP - EDGE;
    const above = panel.top - GAP - EDGE;
    const useBelow = below >= MIN || below >= above;
    const space = Math.max(MIN, Math.min(MAX, useBelow ? below : above));

    ui.popList.style.maxHeight = `${Math.max(60, space - CHROME)}px`;
    ui.pop.style.left = '0px';
    // Measure after the cap is applied; the list may be shorter than the cap.
    ui.pop.style.top = useBelow
      ? `${panel.height + GAP}px`
      : `${-(ui.pop.offsetHeight + GAP)}px`;
  }

  function onPopoverKey(e) {
    const rows = matching();
    if (e.key === 'Escape') {
      // Must not reach the window handler, which would discard the whole report.
      e.preventDefault();
      e.stopPropagation();
      closePopover();
      ui.addLabel.focus();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      cursor = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      renderOptions();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) { closePopover(); submit(); return; }
      if (rows[cursor]) toggleLabel(rows[cursor].name);
    }
  }

  // ------------------------------------------------------------- panel

  let cachedMeta = null;

  async function openPanel() {
    cachedMeta = await collectMeta();
    if (!host) return; // cancelled while metadata was being gathered

    ui.repo.innerHTML = '';
    for (const dest of repoList) {
      const opt = document.createElement('option');
      // Entries are { key, label }; a Linear key like "linear:ENG#ENG-123" is not
      // something anyone should have to read in a dropdown.
      opt.value = dest.key;
      opt.textContent = dest.label;
      ui.repo.append(opt);
    }
    ui.repo.value = currentRepo;

    ui.meta.innerHTML = '';
    const shown = [
      ['URL', cachedMeta.url], ['Browser', cachedMeta.browser], ['OS', cachedMeta.os],
      ['Viewport', cachedMeta.viewport], ['Screen', cachedMeta.screen],
      ['Language', cachedMeta.language], ['Time zone', cachedMeta.timeZone],
    ];
    for (const [k, v] of shown) {
      if (!v) continue;
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = k;
      dd.textContent = v; // textContent, never innerHTML — page-derived strings
      ui.meta.append(dt, dd);
    }

    ui.source.style.display = mode === 'image' ? 'block' : 'none';
    ui.panel.style.display = 'block';
    position();
    ui.title.focus();
    loadLabels(); // not awaited — the report is writable while labels arrive
  }

  /** Below the selection if it fits, above if not, clamped to the viewport. */
  /**
   * Places the panel clear of the selection whenever the viewport allows it. Sitting
   * on top of the selection does not merely hide the screenshot — the panel is above
   * the markup canvas, so anything it covers cannot be drawn on.
   */
  function position() {
    const GAP = 12;
    const box = ui.panel.getBoundingClientRect();
    const W = window.innerWidth, H = window.innerHeight;
    const w = box.width, h = box.height;

    const clampX = (x) => Math.max(GAP, Math.min(x, W - w - GAP));
    const clampY = (y) => Math.max(GAP, Math.min(y, H - h - GAP));
    const fits = (x, y) => x >= GAP && y >= GAP && x + w <= W - GAP && y + h <= H - GAP;

    const spots = [
      { x: clampX(rect.x), y: rect.y + rect.h + GAP },   // below
      { x: clampX(rect.x), y: rect.y - h - GAP },        // above
      { x: rect.x + rect.w + GAP, y: clampY(rect.y) },   // right
      { x: rect.x - w - GAP, y: clampY(rect.y) },        // left
    ];

    let spot = spots.find((s) => fits(s.x, s.y));

    if (!spot) {
      // Nothing clears it; take whichever position covers the least of the selection.
      const hidden = (x, y) => {
        const ox = Math.max(0, Math.min(x + w, rect.x + rect.w) - Math.max(x, rect.x));
        const oy = Math.max(0, Math.min(y + h, rect.y + rect.h) - Math.max(y, rect.y));
        return ox * oy;
      };
      spot = spots
        .map((s) => ({ x: clampX(s.x), y: clampY(s.y) }))
        .sort((a, b) => hidden(a.x, a.y) - hidden(b.x, b.y))[0];
    }

    ui.panel.style.left = `${spot.x}px`;
    ui.panel.style.top = `${spot.y}px`;
  }

  function showError(text) {
    if (!ui.msg) return;
    ui.msg.className = 'msg error';
    ui.msg.textContent = text;
    if (ui.panel && rect) { ui.panel.style.display = 'block'; position(); }
    state = 'composing';
    if (ui.send) { ui.send.disabled = false; ui.send.textContent = 'Try again'; }
  }

  async function submit() {
    if (state === 'sending') return;
    const title = ui.title.value.trim();
    const comment = ui.textarea.value.trim();
    if (!title && !comment) { ui.title.focus(); showError('Add a title or a description.'); return; }
    closePopover();
    if (!cachedMeta) cachedMeta = await collectMeta();
    cachedMeta.source = ui.source.value.trim();

    state = 'sending';
    ui.send.disabled = true;
    ui.cancel.disabled = true;
    ui.title.disabled = true;
    ui.textarea.disabled = true;
    ui.source.disabled = true;
    ui.tools.style.display = 'none';
    ui.draw.style.cursor = 'default';
    ui.send.textContent = 'Creating…';
    ui.msg.className = 'msg';
    ui.msg.textContent = '';

    const res = await chrome.runtime.sendMessage({
      type: 'PIN_SUBMIT', title, comment, meta: cachedMeta,
      repoSlug: ui.repo.value, labels: [...chosen],
      // Selection-relative; the worker scales them onto the full-resolution crop.
      markup: strokes.length ? { width: rect.w, height: rect.h, strokes } : null,
    })
      .catch((err) => ({ ok: false, error: String(err?.message || err) }));

    ui.cancel.disabled = false;

    if (!res?.ok) {
      ui.title.disabled = false;
      ui.textarea.disabled = false;
      ui.source.disabled = false;
      renderTools(); // brings back Undo/Clear and the pencil cursor
      showError(res?.error || 'Something went wrong.');
      return;
    }

    ui.msg.className = 'msg success';
    ui.msg.textContent = '';
    const link = document.createElement('a');
    link.href = res.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = `Issue ${refOf(res.number)} created — open it`;
    ui.msg.append(link);
    ui.send.textContent = 'Done';
    setTimeout(() => close(false), 4000);
  }

  // ------------------------------------------------------------- entry

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'PIN_START') return false;
    // Tear down any previous capture FIRST — close() resets this state, so assigning
    // before it would silently blank the backdrop on a back-to-back capture.
    if (host) close(false);

    repoList = msg.repos || [];
    currentRepo = msg.current || repoList[0] || '';
    shot = msg.shot || '';
    mode = msg.mode === 'image' ? 'image' : 'tab';
    tip = msg.tip || null;
    strokes = [];
    drawing = null;
    inkColor = INKS[0];

    build();
    if (mode === 'image') {
      ui.upload.style.display = 'none';
      ui.uploadSep.style.display = 'none';
    }
    renderTip();
    paintBackdrop();
    sendResponse({ ok: true });
    return false;
  });
})();
