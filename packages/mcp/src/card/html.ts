// The approval card: one self-contained HTML document (inline CSS + JS, no external requests
// besides media previews allowed by the resource CSP). It speaks the MCP Apps postMessage
// JSON-RPC protocol (ui/initialize → ui/notifications/initialized → tool-input / tool-result
// notifications; tools/call for the app-only approval tools) and falls back to ChatGPT's
// window.openai bridge when present. User content is only ever inserted with textContent.
//
// Written with String.raw so backslashes survive; the document must contain no backticks and no
// dollar-brace sequences.

export const APPROVAL_CARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Approve post</title>
<style>
:root {
  --bg: #ffffff; --fg: #15171a; --muted: #5f6670; --line: #e3e6ea; --soft: #f5f6f8;
  --accent: #4f46e5; --accent-fg: #ffffff; --ok: #12805c; --warn: #9a6700; --bad: #c62828;
  --radius: 12px; color-scheme: light dark;
}
:root[data-theme="dark"] {
  --bg: #17191c; --fg: #eceef1; --muted: #a2a9b3; --line: #2c3036; --soft: #202328;
  --accent: #8b85ff; --accent-fg: #0f1012; --ok: #4cc38a; --warn: #e2b33c; --bad: #ff6b6b;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #17191c; --fg: #eceef1; --muted: #a2a9b3; --line: #2c3036; --soft: #202328;
    --accent: #8b85ff; --accent-fg: #0f1012; --ok: #4cc38a; --warn: #e2b33c; --bad: #ff6b6b;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; }
body { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg); }
.card { background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--line); }
.head h1 { font-size: 15px; margin: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pill { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--soft); color: var(--muted); white-space: nowrap; }
.pill.ok { color: var(--ok); } .pill.bad { color: var(--bad); } .pill.warn { color: var(--warn); }
.tabs { display: flex; gap: 4px; padding: 8px 10px 0; overflow-x: auto; border-bottom: 1px solid var(--line); }
.tab { border: 0; background: none; color: var(--muted); padding: 8px 10px; border-bottom: 2px solid transparent; cursor: pointer; font: inherit; white-space: nowrap; }
.tab[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--accent); font-weight: 600; }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-left: 6px; background: var(--ok); vertical-align: middle; }
.dot.bad { background: var(--bad); }
.body { padding: 12px 14px; }
.meta { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
.title { font-weight: 600; margin-bottom: 6px; }
.text { white-space: pre-wrap; word-break: break-word; background: var(--soft); border-radius: 8px; padding: 10px; min-height: 40px; }
.counter { font-size: 12px; color: var(--muted); text-align: right; margin-top: 4px; }
.counter.over { color: var(--bad); font-weight: 600; }
.media { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.thumb { width: 84px; height: 84px; border-radius: 8px; background: var(--soft); border: 1px solid var(--line); object-fit: cover; display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--muted); text-align: center; overflow: hidden; }
.issues { margin: 10px 0 0; padding: 0; list-style: none; }
.issues li { font-size: 13px; padding: 4px 0 4px 18px; position: relative; }
.issues li::before { content: "!"; position: absolute; left: 4px; font-weight: 700; }
.issues li.error { color: var(--bad); } .issues li.warning { color: var(--warn); }
.banner { margin: 10px 14px 0; padding: 8px 10px; border-radius: 8px; font-size: 13px; background: var(--soft); }
.banner.bad { color: var(--bad); } .banner.ok { color: var(--ok); }
textarea, input[type="text"] { width: 100%; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 8px; }
textarea { min-height: 120px; resize: vertical; }
select { width: 100%; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 7px 8px; }
.privacy { margin-top: 10px; }
.options { margin: 10px 0 0; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; font-size: 13px; }
.option { display: flex; gap: 8px; padding: 2px 0; }
.option dt { color: var(--muted); flex: 0 0 auto; }
.option dt::after { content: ":"; }
.option dd { margin: 0; white-space: pre-wrap; word-break: break-word; min-width: 0; }
label { display: block; font-size: 12px; color: var(--muted); margin: 8px 0 4px; }
.actions { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 14px; border-top: 1px solid var(--line); flex-wrap: wrap; }
button.btn { font: inherit; border-radius: 8px; padding: 7px 14px; cursor: pointer; border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
button.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); font-weight: 600; }
button.btn.danger { color: var(--bad); }
button.btn:disabled { opacity: .5; cursor: default; }
a.link, button.link { color: var(--accent); background: none; border: 0; padding: 0; font: inherit; cursor: pointer; text-decoration: underline; }
.empty { padding: 24px 14px; color: var(--muted); text-align: center; }
.done { padding: 22px 14px; text-align: center; }
.done strong { display: block; font-size: 16px; margin-bottom: 4px; }
</style>
</head>
<body>
<div id="root" class="card"><div class="empty">Loading the draft…</div></div>
<script>
(function () {
  'use strict';

  var PROTOCOL_VERSION = '2026-01-26';
  var state = {
    preview: null, nonce: null, expiresAt: null, webUrl: null, active: 0,
    mode: 'view', edit: null, reason: '', busy: false, error: null, done: null, cancelled: false
  };
  var bridge = null; // 'mcp' once ui/initialize succeeded
  var nextId = 1;
  var pending = {};
  var root = document.getElementById('root');

  // ---------------------------------------------------------------- transport (MCP Apps)
  function post(message) {
    if (window.parent && window.parent !== window) window.parent.postMessage(message, '*');
  }
  function request(method, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
      setTimeout(function () {
        if (pending[id]) { delete pending[id]; reject(new Error('The host did not answer.')); }
      }, timeoutMs || 60000);
    });
  }
  function notify(method, params) { post({ jsonrpc: '2.0', method: method, params: params || {} }); }
  function respond(id, result) { post({ jsonrpc: '2.0', id: id, result: result || {} }); }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
    if (msg.method === undefined && msg.id !== undefined && pending[msg.id]) {
      var p = pending[msg.id];
      delete pending[msg.id];
      if (msg.error) p.reject(new Error(String((msg.error && msg.error.message) || 'Request failed.')));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method !== 'string') return;
    switch (msg.method) {
      case 'ui/notifications/tool-result': applyResult(msg.params); break;
      case 'ui/notifications/tool-input': break;
      case 'ui/notifications/tool-input-partial': break;
      case 'ui/notifications/tool-cancelled': state.cancelled = true; render(); break;
      case 'ui/notifications/host-context-changed': applyContext(msg.params); break;
      case 'ui/resource-teardown': if (msg.id !== undefined) respond(msg.id, {}); break;
      case 'ping': if (msg.id !== undefined) respond(msg.id, {}); break;
      default:
        if (msg.id !== undefined) post({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    }
  });

  function applyContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return;
    if (ctx.theme === 'dark' || ctx.theme === 'light') document.documentElement.setAttribute('data-theme', ctx.theme);
    var vars = ctx.styles && ctx.styles.variables;
    if (vars && typeof vars === 'object') {
      Object.keys(vars).forEach(function (k) {
        if (k.indexOf('--') === 0 && typeof vars[k] === 'string') document.documentElement.style.setProperty(k, vars[k]);
      });
    }
  }

  function connectMcp() {
    if (!window.parent || window.parent === window) return;
    request('ui/initialize', {
      protocolVersion: PROTOCOL_VERSION,
      appInfo: { name: 'approval-card', version: '1.0.0' },
      appCapabilities: { availableDisplayModes: ['inline'] }
    }, 15000).then(function (result) {
      bridge = 'mcp';
      applyContext(result && result.hostContext);
      notify('ui/notifications/initialized', {});
      reportSize();
    }, function () { /* not an MCP Apps host (or no answer): window.openai fallback below */ });
  }

  // ---------------------------------------------------------------- ChatGPT Apps SDK fallback
  function openai() { return window.openai && typeof window.openai === 'object' ? window.openai : null; }
  function readOpenAiGlobals() {
    var o = openai();
    if (!o) return;
    if (o.theme === 'dark' || o.theme === 'light') document.documentElement.setAttribute('data-theme', o.theme);
    if (!state.preview && (o.toolResponseMetadata || o.toolOutput)) {
      applyResult({ structuredContent: o.toolOutput || null, _meta: o.toolResponseMetadata || null });
    }
  }
  window.addEventListener('openai:set_globals', readOpenAiGlobals);

  function callTool(name, args) {
    if (bridge === 'mcp') return request('tools/call', { name: name, arguments: args });
    var o = openai();
    if (o && typeof o.callTool === 'function') return Promise.resolve(o.callTool(name, args));
    return Promise.reject(new Error('This chat app cannot run the card buttons. Use the web app link instead.'));
  }

  function openLink(url) {
    if (!url) return;
    if (bridge === 'mcp') { request('ui/open-link', { url: url }).catch(function () {}); return; }
    var o = openai();
    if (o && typeof o.openExternal === 'function') { o.openExternal({ href: url }); return; }
    window.open(url, '_blank', 'noopener');
  }

  function tellModel(text) {
    if (bridge !== 'mcp') return;
    request('ui/update-model-context', { content: [{ type: 'text', text: text }] }, 10000).catch(function () {});
  }

  // ---------------------------------------------------------------- results
  function resultText(result) {
    var parts = (result && Array.isArray(result.content)) ? result.content : [];
    for (var i = 0; i < parts.length; i++) if (parts[i] && parts[i].type === 'text') return String(parts[i].text || '');
    return '';
  }

  function applyResult(result) {
    if (!result || typeof result !== 'object') return;
    if (result.isError) { state.error = resultText(result) || 'Something went wrong.'; render(); return; }
    var meta = result._meta && result._meta.approvalCard;
    if (meta && meta.preview) {
      state.preview = meta.preview;
      state.nonce = typeof meta.nonce === 'string' ? meta.nonce : null;
      state.expiresAt = meta.expiresAt || null;
      state.webUrl = meta.webUrl || state.webUrl;
    } else if (result.structuredContent && result.structuredContent.preview) {
      state.preview = result.structuredContent.preview;
      state.webUrl = result.structuredContent.approvalUrl || state.webUrl;
    }
    if (state.preview && state.active >= state.preview.variants.length) state.active = 0;
    render();
  }

  // ---------------------------------------------------------------- actions
  function current() { return state.preview && state.preview.variants[state.active]; }

  function run(name, args, onSuccess) {
    state.busy = true; state.error = null; render();
    callTool(name, args).then(function (result) {
      state.busy = false;
      if (!result || result.isError) {
        state.error = resultText(result) || 'The request failed.';
        render();
        return;
      }
      onSuccess(result);
    }, function (err) {
      state.busy = false;
      state.error = (err && err.message) || 'The request failed.';
      render();
    });
  }

  function approve() {
    var d = state.preview.draft;
    run('approval_decide', { draftId: d.id, nonce: state.nonce, decision: 'approve' }, function () {
      state.done = 'approved'; state.nonce = null; render();
      tellModel('The user approved draft ' + d.id + ' in the approval card. It is not published yet; it can now be scheduled with schedule_post.');
    });
  }

  function reject(reason) {
    var d = state.preview.draft;
    var args = { draftId: d.id, nonce: state.nonce, decision: 'reject' };
    if (reason) args.reason = reason;
    run('approval_decide', args, function () {
      state.done = 'rejected'; state.nonce = null; state.reason = ''; render();
      tellModel('The user rejected draft ' + d.id + (reason ? ' with the reason: ' + reason : '') + '.');
    });
  }

  function startEdit() {
    var v = current();
    state.mode = 'edit'; state.error = null;
    state.edit = { text: v.text, title: v.title === null || v.title === undefined ? null : v.title };
    render();
  }

  function saveEdit() {
    var d = state.preview.draft;
    var v = current();
    var e = state.edit || { text: v.text, title: null };
    var args = { draftId: d.id, nonce: state.nonce, platform: v.platform };
    if (e.text !== v.text) args.text = e.text;
    if (e.title !== null && e.title !== (v.title || '')) args.title = e.title;
    if (args.text === undefined && args.title === undefined) { state.mode = 'view'; state.edit = null; render(); return; }
    run('approval_edit_variant', args, function (result) {
      state.mode = 'view'; state.edit = null;
      applyResult(result);
      tellModel('The user edited the ' + v.label + ' text of draft ' + d.id + ' in the approval card.');
    });
  }

  // TikTok requires the person to choose who can see each post (no default). Same values and
  // labels as TIKTOK_PRIVACY_LEVELS / TIKTOK_PRIVACY_LABELS in @app/core/validation.
  var TIKTOK_PRIVACY = [
    ['PUBLIC_TO_EVERYONE', 'Everyone'],
    ['MUTUAL_FOLLOW_FRIENDS', 'Friends (followers you follow back)'],
    ['FOLLOWER_OF_CREATOR', 'Followers'],
    ['SELF_ONLY', 'Only me']
  ];

  function setPrivacy(v, level) {
    var d = state.preview.draft;
    if (!level) return;
    run('approval_edit_variant', { draftId: d.id, nonce: state.nonce, platform: v.platform, privacyLevel: level }, function (result) {
      applyResult(result);
      tellModel('The user chose who can see the ' + v.label + ' post of draft ' + d.id + ' in the approval card.');
    });
  }

  // ---------------------------------------------------------------- rendering helpers
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var value = attrs[k];
      if (value === null || value === undefined || value === false) return;
      if (k === 'text') node.textContent = String(value);
      else if (k === 'onclick') node.addEventListener('click', value);
      else if (k === 'oninput') node.addEventListener('input', value);
      else node.setAttribute(k, value === true ? '' : String(value));
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  var segmenter = (typeof Intl !== 'undefined' && Intl.Segmenter) ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  function measure(text, unit) {
    if (unit === 'utf8_bytes' && typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
    if (unit === 'graphemes' && segmenter) { var n = 0; for (var _ of segmenter.segment(text)) n++; return n; }
    return text.length; // utf16; x_weighted is checked exactly by the server on save
  }

  function safeUrl(url) {
    if (typeof url !== 'string') return null;
    try {
      var u = new URL(url);
      return (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'blob:') ? u.toString() : null;
    } catch (e) { return null; }
  }

  function counter(used, max, unit) {
    var over = max > 0 && used > max;
    var label = unit === 'utf8_bytes' ? 'bytes' : 'characters';
    return el('div', { class: 'counter' + (over ? ' over' : ''), text: used + ' / ' + max + ' ' + label + (over ? ' (' + (used - max) + ' over)' : '') });
  }

  function mediaThumbs(media) {
    if (!media || media.length === 0) return null;
    return el('div', { class: 'media' }, media.map(function (m) {
      var url = safeUrl(m.url);
      if (url && m.kind === 'image') return el('img', { class: 'thumb', src: url, alt: 'Image' });
      if (url && m.kind === 'video') return el('video', { class: 'thumb', src: url, muted: true, preload: 'metadata', playsinline: true, controls: true });
      return el('div', { class: 'thumb', text: (m.kind || 'file') + (m.status && m.status !== 'ready' ? ' (' + m.status + ')' : '') });
    }));
  }

  function issuesList(issues) {
    if (!issues || issues.length === 0) return null;
    return el('ul', { class: 'issues' }, issues.map(function (i) {
      return el('li', { class: i.severity === 'error' ? 'error' : 'warning', text: i.message });
    }));
  }

  // Everything the variant publishes besides the text (first comment, collaborators, visibility,
  // page/board/playlist ids...). TikTok's "Who can see" has its own picker below.
  function optionsList(v) {
    var lines = (v.optionLines || []).filter(function (l) { return !(v.platform === 'tiktok' && l.key === 'privacyLevel'); });
    if (lines.length === 0) return null;
    return el('dl', { class: 'options', 'aria-label': 'Also published with this post' }, lines.map(function (l) {
      return el('div', { class: 'option' }, [el('dt', { text: l.label }), el('dd', { text: l.value })]);
    }));
  }

  function accountText(v) {
    if (!v.account) return v.label + ': not connected';
    var name = v.account.handle ? '@' + String(v.account.handle).replace(/^@/, '') : (v.account.displayName || 'account');
    return v.label + ' · ' + name + (v.account.status !== 'active' ? ' (' + v.account.status + ')' : '');
  }

  function privacyPicker(v) {
    if (v.platform !== 'tiktok') return null;
    var current = v.options && typeof v.options.privacyLevel === 'string' ? v.options.privacyLevel : '';
    var select = el('select', { id: 'tiktok-privacy', disabled: !state.nonce || state.busy });
    var placeholder = el('option', { value: '', text: 'Choose…', disabled: true });
    select.appendChild(placeholder);
    TIKTOK_PRIVACY.forEach(function (p) { select.appendChild(el('option', { value: p[0], text: p[1] })); });
    select.value = current;
    if (!current) placeholder.selected = true;
    select.addEventListener('change', function () { setPrivacy(v, select.value); });
    return el('div', { class: 'privacy' }, [el('label', { for: 'tiktok-privacy', text: 'Who can see this TikTok post' }), select]);
  }

  // ---------------------------------------------------------------- views
  function viewPanel(v) {
    var used = v.length ? v.length.used : v.text.length;
    var max = v.length ? v.length.max : 0;
    return el('div', { class: 'body' }, [
      el('div', { class: 'meta', text: accountText(v) }),
      v.title ? el('div', { class: 'title', text: v.title }) : null,
      el('div', { class: 'text', text: v.text || '(no text)' }),
      counter(used, max, v.length && v.length.unit),
      optionsList(v),
      privacyPicker(v),
      mediaThumbs(v.media),
      issuesList(v.issues)
    ]);
  }

  function editPanel(v) {
    // the edit lives in state.edit, so a failed save (re-render) keeps what the user typed
    var e = state.edit || (state.edit = { text: v.text, title: v.title === null || v.title === undefined ? null : v.title });
    var unit = v.length && v.length.unit;
    var max = v.length ? v.length.max : 0;
    var count = counter(measure(e.text, unit), max, unit);
    var area = el('textarea', { 'aria-label': 'Post text' });
    area.value = e.text;
    area.addEventListener('input', function () {
      e.text = area.value;
      var fresh = counter(measure(e.text, unit), max, unit);
      count.replaceWith(fresh); count = fresh;
    });
    var children = [el('div', { class: 'meta', text: 'Editing ' + v.label })];
    if (e.title !== null || v.platform === 'youtube' || v.platform === 'pinterest' || v.platform === 'tiktok') {
      if (e.title === null) e.title = '';
      var titleInput = el('input', { type: 'text', 'aria-label': 'Title' });
      titleInput.value = e.title;
      titleInput.addEventListener('input', function () { e.title = titleInput.value; });
      children.push(el('label', { text: 'Title' }), titleInput);
    }
    children.push(el('label', { text: 'Text' }), area, count);
    return el('div', { class: 'body' }, children);
  }

  function rejectPanel() {
    var area = el('textarea', { 'aria-label': 'Reason', placeholder: 'Optional: what should change?' });
    area.value = state.reason;
    area.style.minHeight = '70px';
    area.addEventListener('input', function () { state.reason = area.value; });
    return el('div', { class: 'body' }, [el('label', { text: 'Reason for rejecting (optional)' }), area]);
  }

  function statusPill(p) {
    var d = p.draft;
    if (d.status === 'approved' && d.approvedRevision === d.revision && d.approvedVia === 'auto_post') return el('span', { class: 'pill ok', text: 'Auto-posted' });
    if (state.done === 'approved' || (d.status === 'approved' && d.approvedRevision === d.revision)) return el('span', { class: 'pill ok', text: 'Approved' });
    if (state.done === 'rejected' || d.status === 'rejected') return el('span', { class: 'pill bad', text: 'Rejected' });
    if (!p.ready) return el('span', { class: 'pill warn', text: 'Needs fixes' });
    return el('span', { class: 'pill', text: 'Waiting for approval' });
  }

  function render() {
    root.textContent = '';
    var p = state.preview;
    if (!p) {
      root.appendChild(el('div', { class: state.error ? 'banner bad' : 'empty', text: state.error || (state.cancelled ? 'Cancelled.' : 'Loading the draft…') }));
      reportSize();
      return;
    }
    root.appendChild(el('div', { class: 'head' }, [
      el('h1', { text: (p.brand && p.brand.name ? p.brand.name + ' · ' : '') + 'Review post' }),
      el('span', { class: 'pill', text: 'rev ' + p.draft.revision }),
      statusPill(p)
    ]));

    if (state.done) {
      root.appendChild(el('div', { class: 'done' }, [
        el('strong', { text: state.done === 'approved' ? 'Approved' : 'Rejected' }),
        el('div', { class: 'meta', text: state.done === 'approved' ? 'Nothing is published yet. Ask the assistant to schedule it.' : 'The draft will not be published.' })
      ]));
      reportSize();
      return;
    }

    (p.problems || []).forEach(function (msg) { root.appendChild(el('div', { class: 'banner bad', text: msg })); });
    if (state.error) root.appendChild(el('div', { class: 'banner bad', role: 'alert', text: state.error }));
    if (state.cancelled) root.appendChild(el('div', { class: 'banner', text: 'The request was cancelled.' }));

    if (p.variants.length === 0) {
      root.appendChild(el('div', { class: 'empty', text: 'This draft has no platforms yet.' }));
    } else {
      root.appendChild(el('div', { class: 'tabs', role: 'tablist' }, p.variants.map(function (v, i) {
        return el('button', {
          class: 'tab', role: 'tab', 'aria-selected': i === state.active ? 'true' : 'false',
          onclick: function () { if (state.mode === 'view') { state.active = i; render(); } }
        }, [document.createTextNode(v.label), el('span', { class: 'dot' + (v.ready ? '' : ' bad'), title: v.ready ? 'Ready' : 'Needs fixes' })]);
      })));
    }

    var v = current();
    var panel = null;
    if (v && state.mode === 'edit') panel = editPanel(v);
    else if (state.mode === 'reject') panel = rejectPanel();
    else if (v) panel = viewPanel(v);
    if (panel) root.appendChild(panel);

    var canAct = !!state.nonce && !state.busy;
    var approvedNow = p.draft.status === 'approved' && p.draft.approvedRevision === p.draft.revision;
    var buttons = [];
    if (!state.nonce) {
      var autoPosted = approvedNow && p.draft.approvedVia === 'auto_post';
      buttons.push(el('span', { class: 'meta', text: autoPosted ? 'Posted automatically: Auto-post is on for this brand. Cancel a post in the web app calendar.' : 'Approve this draft in the web app.' }));
    } else if (state.mode === 'edit') {
      buttons.push(el('button', { class: 'btn', onclick: function () { state.mode = 'view'; state.edit = null; state.error = null; render(); }, disabled: state.busy, text: 'Cancel' }));
      buttons.push(el('button', { class: 'btn primary', onclick: saveEdit, disabled: !canAct, text: state.busy ? 'Saving…' : 'Save changes' }));
    } else if (state.mode === 'reject') {
      buttons.push(el('button', { class: 'btn', onclick: function () { state.mode = 'view'; state.error = null; render(); }, disabled: state.busy, text: 'Cancel' }));
      buttons.push(el('button', { class: 'btn danger', onclick: function () { reject(state.reason.trim()); }, disabled: !canAct, text: state.busy ? 'Rejecting…' : 'Reject draft' }));
    } else {
      buttons.push(el('button', { class: 'btn danger', onclick: function () { state.mode = 'reject'; state.error = null; render(); }, disabled: !canAct, text: 'Reject' }));
      if (v) buttons.push(el('button', { class: 'btn', onclick: startEdit, disabled: !canAct, text: 'Edit' }));
      buttons.push(el('button', {
        class: 'btn primary', onclick: approve, disabled: !canAct || !p.ready || approvedNow,
        title: p.ready ? null : 'Fix the problems first', text: state.busy ? 'Approving…' : (approvedNow ? 'Approved' : 'Approve')
      }));
    }
    if (state.webUrl) buttons.unshift(el('button', { class: 'link', onclick: function () { openLink(state.webUrl); }, text: 'Open in web app' }));
    root.appendChild(el('div', { class: 'actions' }, buttons));
    reportSize();
  }

  // ---------------------------------------------------------------- sizing
  var lastHeight = 0;
  // The card's own height, not the document's: documentElement.scrollHeight is never smaller than
  // the iframe the host gave us, so the card could grow but never shrink (e.g. after Approve).
  function reportSize() {
    if (bridge !== 'mcp') return;
    var h = Math.ceil(root.getBoundingClientRect().height);
    if (h === lastHeight) return;
    lastHeight = h;
    notify('ui/notifications/size-changed', { width: Math.ceil(document.documentElement.scrollWidth), height: h });
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(reportSize).observe(root);

  connectMcp();
  readOpenAiGlobals();
  render();
})();
</script>
</body>
</html>
`
