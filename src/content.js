(() => {
  const cfg = { enabled: true, debug: false, button: true };
  const hits = [];
  let blockedCount = 0;
  let pending = 0;

  const SKIP_TAGS = new Set(['HTML', 'BODY', 'HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'NOSCRIPT']);

  // Third parties that legitimately load invisible or zero-size frames.
  const SAFE_HOSTS = [
    'google.com/recaptcha',
    'gstatic.com/recaptcha',
    'hcaptcha.com',
    'challenges.cloudflare.com',
    'js.stripe.com',
    'paypal.com',
    'paypalobjects.com',
    'accounts.google.com',
    'apis.google.com',
    'youtube.com/embed',
    'youtube-nocookie.com',
    'player.vimeo.com',
    'disqus.com'
  ];

  const FRAME_TAGS = new Set(['IFRAME', 'EMBED', 'OBJECT']);

  // Above the common ad rectangles (300x250, 336x280, 728x90) so a banner
  // wrapper is never read as a player.
  const PLAYER_MIN_W = 400;
  const PLAYER_MIN_H = 225;

  const baseDomain = (h) => h.split('.').slice(-2).join('.');

  const isThirdParty = (url) => {
    try {
      const u = new URL(url, location.href);
      if (!/^https?:$/.test(u.protocol)) return false;
      return baseDomain(u.hostname) !== baseDomain(location.hostname);
    } catch {
      return false;
    }
  };

  const isSafeHost = (url) => SAFE_HOSTS.some((h) => String(url).includes(h));

  const transparentBg = (color) => {
    if (!color || color === 'transparent') return true;
    const m = color.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const parts = m[1].split(',').map((v) => parseFloat(v));
    return parts.length === 4 && parts[3] < 0.05;
  };

  const frameSrc = (el) => el.src || el.getAttribute('src') || el.getAttribute('data-src') || el.getAttribute('data') || '';

  const everLarge = new WeakSet();

  // A wrapper holds nothing but an iframe, so a "no text or image" test reads it
  // as a click catcher. Paint state is ignored: closed modals still lay out.
  function wrapsPlayer(el) {
    const f = FRAME_TAGS.has(el.tagName) || el.tagName === 'VIDEO' ? el : el.querySelector('iframe, embed, object, video');
    if (!f) return false;
    const r = f.getBoundingClientRect();
    if (r.width < PLAYER_MIN_W || r.height < PLAYER_MIN_H) return false;
    everLarge.add(f);
    return true;
  }

  const VISIBLE_CONTENT = 'img, svg, video, canvas, picture, iframe, embed, object';

  // A full-bleed backdrop <img> has no descendants and no text, so the element
  // itself has to count.
  const hasVisibleContent = (el) =>
    el.matches(VISIBLE_CONTENT) || el.querySelector(VISIBLE_CONTENT) || el.textContent.trim().length > 0;

  function classify(el, mature) {
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag)) return null;
    if (el.hasAttribute('data-gb') || el.closest('[data-gb-ui]')) return null;
    if (tag === 'VIDEO' || tag === 'CANVAS') return null;
    // Ad injectors use plain div/a/iframe/ins, so a hyphenated tag is another
    // extension's UI. Grammarly parks a card at 2147483646.
    if (tag.includes('-')) return null;
    if (wrapsPlayer(el)) return null;

    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const vw = innerWidth || 1;
    const vh = innerHeight || 1;

    if (FRAME_TAGS.has(tag)) {
      const src = frameSrc(el);
      if (!src || !isThirdParty(src) || isSafeHost(src)) return null;
      // Before layout a frame measures 0x0 and computes as hidden. Judging a
      // player in that window kills it on every load.
      if (!mature) return null;
      if (everLarge.has(el)) return null;
      if (r.width <= 3 || r.height <= 3) return 'zero-size third-party frame';
      if (cs.display === 'none' || cs.visibility === 'hidden') return 'display:none third-party frame';
      if (parseFloat(cs.opacity) < 0.1) return 'transparent third-party frame';
      if (r.bottom < -100 || r.right < -100 || r.top > vh + 2000 || r.left > vw + 500) return 'off-screen third-party frame';
      return null;
    }

    const pos = cs.position;
    if (pos !== 'fixed' && pos !== 'absolute') return null;

    // Cannot receive a click, so cannot be catching one. This is the closed-modal
    // pattern. opacity:0 alone still takes clicks and stays a threat.
    if (cs.visibility === 'hidden' || cs.display === 'none') return null;

    const area = r.width * r.height;
    if (area < 10000) return null;
    const coversViewport = r.width >= vw * 0.7 && r.height >= vh * 0.5;
    const z = parseInt(cs.zIndex, 10) || 0;

    // Ad layers sit at the top of the int32 range, shipping pointer-events:none
    // and flipping it on the first click, so this has to fire before the flip.
    if (coversViewport && z >= 1000000 && !hasVisibleContent(el)) return 'max z-index ad layer';

    if (cs.pointerEvents === 'none') return null;

    const invisible = parseFloat(cs.opacity) < 0.15 || (transparentBg(cs.backgroundColor) && !hasVisibleContent(el));
    if (coversViewport && invisible) return 'transparent full-page click catcher';

    const link = el.matches('a[href]') ? el : el.querySelector('a[href]');
    if (coversViewport && z > 999 && link && isThirdParty(link.href)) return 'full-page third-party overlay';

    if (tag === 'A' && el.href && isThirdParty(el.href) && !hasVisibleContent(el)) return 'invisible link overlay';

    return null;
  }

  function neutralize(el, reason) {
    el.setAttribute('data-gb', reason);

    if (cfg.debug) {
      el.style.setProperty('outline', '3px solid #ff2d55', 'important');
      el.style.setProperty('outline-offset', '-3px', 'important');
      el.style.setProperty('background', 'rgba(255,45,85,.15)', 'important');
      el.title = 'Ghostblock: ' + reason;
    } else {
      el.style.setProperty('display', 'none', 'important');
      el.style.setProperty('pointer-events', 'none', 'important');
      // Blanking src needs a reload to undo, so only tracker pixels get it.
      if (FRAME_TAGS.has(el.tagName) && reason.startsWith('zero-size')) {
        try {
          el.src = 'about:blank';
        } catch {}
      }
    }

    blockedCount++;
    hits.push({ reason, tag: el.tagName.toLowerCase(), id: el.id || '', cls: (el.className || '').toString().slice(0, 80) });
    paintButton();
    report();
  }

  let reportTimer = null;
  function report() {
    if (reportTimer) return;
    reportTimer = setTimeout(() => {
      reportTimer = null;
      const batch = hits.splice(0, hits.length);
      if (!batch.length) return;
      try {
        const p = chrome.runtime.sendMessage({ type: 'blocked', items: batch });
        if (p && p.catch) p.catch(() => {});
      } catch {}
    }, 250);
  }

  // Overlays are body children or carry inline positioning. Scanning every div
  // would force a layout pass per element per tick.
  const CANDIDATES = [
    'iframe',
    'embed',
    'object',
    'ins',
    'body > div',
    'body > section',
    'body > aside',
    'body > a',
    '[style*="position"]',
    '[style*="z-index"]',
    'a[target="_blank"]'
  ].join(',');

  const checks = new WeakMap();

  function inspect(el) {
    const seen = checks.get(el) || 0;
    if (seen > 5) return;
    checks.set(el, seen + 1);
    const mature = seen >= 1 && document.readyState !== 'loading';
    let reason = null;
    try {
      reason = classify(el, mature);
    } catch {}
    if (reason) neutralize(el, reason);
  }

  function sweep(root) {
    if (!cfg.enabled) return;
    const nodes = root.querySelectorAll ? root.querySelectorAll(CANDIDATES) : [];
    for (const el of nodes) inspect(el);
    if (root instanceof Element) inspect(root);
  }

  function schedule() {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      sweep(document);
    });
  }

  const observer = new MutationObserver((records) => {
    if (!cfg.enabled) return;
    let dirty = false;
    for (const rec of records) {
      // A restyled element is a new decision, so it gets its check budget back.
      if (rec.type === 'attributes' && rec.target instanceof Element) checks.delete(rec.target);
      if (rec.type === 'attributes' || rec.addedNodes.length) dirty = true;
    }
    if (dirty) schedule();
  });

  // Peel ad layers from under the pointer so the click lands on what is beneath.
  function shieldAt(x, y) {
    if (!document.elementsFromPoint) return;
    for (const el of document.elementsFromPoint(x, y)) {
      if (!(el instanceof Element) || SKIP_TAGS.has(el.tagName)) break;
      if (el.hasAttribute('data-gb')) continue;
      let reason = null;
      try {
        reason = classify(el, true);
      } catch {}
      if (!reason) break;
      neutralize(el, reason);
    }
  }

  addEventListener(
    'pointerdown',
    (e) => {
      if (cfg.enabled && !cfg.debug && e.isTrusted) shieldAt(e.clientX, e.clientY);
    },
    true
  );

  // Overlay anchors that survive the sweep still lose their click.
  addEventListener(
    'click',
    (e) => {
      if (!cfg.enabled || cfg.debug || !e.isTrusted) return;
      const t = e.target;
      if (t && t.closest && t.closest('[data-gb-ui]')) return;
      const a = t && t.closest ? t.closest('a[href]') : null;
      if (!a || !isThirdParty(a.href)) return;
      if (wrapsPlayer(a)) return;
      const r = a.getBoundingClientRect();
      const covers = r.width >= innerWidth * 0.7 && r.height >= innerHeight * 0.5;
      if (covers || !hasVisibleContent(a)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        blockedCount++;
        hits.push({ reason: 'blocked overlay click', tag: 'a', id: a.id || '', cls: a.href.slice(0, 80) });
        paintButton();
        report();
      }
    },
    true
  );

  addEventListener('__gb_hit', (e) => {
    const d = e.detail || {};
    blockedCount++;
    hits.push({ reason: d.kind === 'popup' ? 'popup blocked' : d.kind, tag: 'window', id: '', cls: String(d.detail).slice(0, 120) });
    paintButton();
    report();
  });

  let btn = null;
  let label = null;

  function buildButton() {
    if (btn || window.top !== window || !document.body || !cfg.button) return;
    const host = document.createElement('div');
    host.setAttribute('data-gb-ui', '1');
    host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML =
      '<style>' +
      'button{font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;' +
      'display:flex;align-items:center;gap:7px;padding:0 12px 0 9px;height:32px;' +
      'border-radius:999px;border:1px solid rgba(255,255,255,.13);cursor:pointer;color:#f6f8fc;' +
      'background:linear-gradient(180deg,#242c3d,#0e121b);' +
      'box-shadow:0 3px 14px rgba(0,0,0,.4);opacity:.42;transition:opacity .16s,transform .16s}' +
      'button:hover{opacity:1;transform:translateY(-1px)}' +
      'svg{width:15px;height:15px;flex:0 0 auto}' +
      '.n{font-variant-numeric:tabular-nums;letter-spacing:-.01em}' +
      '</style>' +
      '<button>' +
      '<svg viewBox="0 0 24 24" fill="none">' +
      '<path d="M6 20.5V10a6 6 0 0 1 12 0v10.5l-2-1.7-2 1.7-2-1.7-2 1.7-2-1.7Z" fill="#f6f8fc"/>' +
      '<path class="slash" d="M4 20.5 20 3.5" stroke="#ff4757" stroke-width="2.6" stroke-linecap="round"/>' +
      '</svg><span class="n"></span></button>';
    btn = root.querySelector('button');
    label = root.querySelector('.n');
    btn.addEventListener('click', toggleTab);
    document.documentElement.appendChild(host);
    paintButton();
  }

  function paintButton() {
    if (!btn) return;
    label.textContent = String(blockedCount);
    btn.title = 'Ghostblock on, ' + blockedCount + ' blocked. Click to turn off for this tab.';
  }

  async function toggleTab() {
    try {
      await chrome.runtime.sendMessage({ type: 'setActive', active: false });
    } catch {}
    location.reload();
  }

  function start() {
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'src'] });
    sweep(document);

    // These SDKs re-inject on a forever interval, so the sweep cannot stop. Fast
    // while the page settles, then a cheap backstop.
    let n = 0;
    let tick = setInterval(() => {
      sweep(document);
      if (++n === 30) {
        clearInterval(tick);
        tick = setInterval(() => sweep(document), 5000);
      }
    }, 1000);

    addEventListener('load', () => sweep(document));
    addEventListener('visibilitychange', () => {
      if (!document.hidden) sweep(document);
    });
  }

  function mountUi() {
    if (document.body) buildButton();
    else addEventListener('DOMContentLoaded', buildButton, { once: true });
  }

  // Protection is opt-in per tab. Everything above stays dormant until the
  // background confirms the user turned this tab on.
  (async () => {
    let active = false;
    try {
      active = (await chrome.runtime.sendMessage({ type: 'hello' })) === true;
    } catch {}
    const s = await chrome.storage.local.get({ debug: false, button: true });
    cfg.enabled = active;
    cfg.debug = s.debug;
    cfg.button = s.button;
    dispatchEvent(new CustomEvent('__gb_cfg', { detail: { enabled: cfg.enabled } }));
    if (cfg.enabled) {
      start();
      mountUi();
    }
  })();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'rescan' && cfg.enabled) sweep(document);
  });
})();
