(() => {
  let enabled = true;

  // The isolated script reads storage asynchronously, so we start blocking and
  // stand down only if this site is allowlisted.
  addEventListener('__gb_cfg', (e) => {
    enabled = !!(e.detail && e.detail.enabled);
    if (!enabled) restore();
  });

  // The SDK runs open.toString().includes('[native code]') and, when it sees a
  // patch, builds a clean about:blank iframe and calls that realm's open
  // instead. Patched functions have to keep reading as native or every hook
  // below is routed around.
  const nativeToString = Function.prototype.toString;
  const spoofed = new WeakSet();

  const looksNative = (fn, name) => {
    spoofed.add(fn);
    try {
      Object.defineProperty(fn, 'name', { value: name, configurable: true });
    } catch {}
    return fn;
  };

  Function.prototype.toString = function () {
    if (spoofed.has(this)) return 'function ' + (this.name || '') + '() { [native code] }';
    return nativeToString.apply(this, arguments);
  };
  spoofed.add(Function.prototype.toString);

  const report = (kind, detail) => {
    dispatchEvent(new CustomEvent('__gb_hit', { detail: { kind, detail: String(detail || '') } }));
  };

  const lastClick = { at: 0, href: null };
  addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted) return;
      lastClick.at = Date.now();
      const t = e.target;
      const a = t && t.closest ? t.closest('a[href]') : null;
      lastClick.href = a ? a.href : null;
    },
    true
  );

  const sameSite = (url) => {
    try {
      const h = new URL(url, location.href).hostname;
      const base = (n) => n.split('.').slice(-2).join('.');
      return base(h) === base(location.hostname);
    } catch {
      return true;
    }
  };

  // Popunders fire window.open from a click on unrelated page chrome (the player,
  // the body). A genuine link opens the same href the user pressed.
  const isUserIntent = (url) => {
    if (!url) return false;
    if (Date.now() - lastClick.at > 1000) return false;
    if (!lastClick.href) return false;
    try {
      return new URL(lastClick.href, location.href).href === new URL(url, location.href).href;
    } catch {
      return false;
    }
  };

  // The SDK polls popup.closed to learn whether the popunder landed. Reporting
  // closed immediately advertises the block and it retries by another route.
  // Looking open for a few seconds reads as a served impression instead.
  const stubWindow = () => {
    const noop = () => {};
    const born = Date.now();
    const doc = {
      write: noop,
      writeln: noop,
      open: () => doc,
      close: noop,
      body: null,
      head: null,
      cookie: '',
      createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop, click: noop }),
      appendChild: noop,
      getElementById: () => null,
      querySelector: () => null,
      addEventListener: noop
    };
    return {
      get closed() {
        return Date.now() - born > 4000;
      },
      opener: null,
      document: doc,
      location: { href: 'about:blank', assign: noop, replace: noop, reload: noop, toString: () => 'about:blank' },
      focus: noop,
      blur: noop,
      close: noop,
      moveTo: noop,
      moveBy: noop,
      resizeTo: noop,
      resizeBy: noop,
      print: noop,
      alert: noop,
      postMessage: noop,
      addEventListener: noop,
      removeEventListener: noop
    };
  };

  // Their cap is "one impression per hour, reset if the tab was away 60s".
  // Refreshing the stamp after a block makes the cap do our work for us. Only
  // touched when the key already exists, so innocent sites are left alone.
  const markServed = () => {
    try {
      if (localStorage.getItem('shown_at') !== null) localStorage.setItem('shown_at', String(Date.now()));
    } catch {}
  };

  const nativeOpen = window.open;
  const nativeAnchorClick = HTMLAnchorElement.prototype.click;

  window.open = function (url, name, features) {
    if (!enabled) return nativeOpen.apply(window, arguments);
    if (sameSite(url) || isUserIntent(url)) return nativeOpen.apply(window, arguments);
    report('popup', url || '(blank)');
    markServed();
    return stubWindow();
  };
  looksNative(window.open, 'open');

  HTMLAnchorElement.prototype.click = function () {
    if (enabled && this.target === '_blank' && this.href && !sameSite(this.href) && !isUserIntent(this.href)) {
      report('popup', this.href);
      return;
    }
    return nativeAnchorClick.apply(this, arguments);
  };

  // 123movies-style SDKs skip window.open entirely: build a form, target _blank,
  // submit, remove. Nothing else on a page submits a cross-site _blank form.
  const nativeSubmit = HTMLFormElement.prototype.submit;
  const nativeRequestSubmit = HTMLFormElement.prototype.requestSubmit;

  const blockedForm = (form) => {
    if (!enabled) return false;
    if (form.target !== '_blank') return false;
    const action = form.action || form.getAttribute('action') || '';
    if (sameSite(action) || isUserIntent(action)) return false;
    report('popup', action || '(form)');
    markServed();
    return true;
  };

  HTMLFormElement.prototype.submit = function () {
    if (blockedForm(this)) return;
    return nativeSubmit.apply(this, arguments);
  };

  HTMLFormElement.prototype.requestSubmit = function () {
    if (blockedForm(this)) return;
    return nativeRequestSubmit.apply(this, arguments);
  };

  looksNative(HTMLAnchorElement.prototype.click, 'click');
  looksNative(HTMLFormElement.prototype.submit, 'submit');
  looksNative(HTMLFormElement.prototype.requestSubmit, 'requestSubmit');

  // Second escape route: create an about:blank iframe and call that realm's
  // untouched open. Patch each child realm the moment the page reaches for it.
  const frameDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
  const patchedRealms = new WeakSet();

  if (frameDesc && frameDesc.get) {
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      configurable: true,
      enumerable: frameDesc.enumerable,
      get() {
        const w = frameDesc.get.call(this);
        if (enabled && w && !patchedRealms.has(w)) {
          patchedRealms.add(w);
          try {
            // Throws for cross-origin realms, which cannot be reached anyway.
            const childOpen = w.open;
            w.open = function (url) {
              if (sameSite(url) || isUserIntent(url)) return childOpen.apply(w, arguments);
              report('popup', (url || '(blank)') + ' [iframe realm]');
              markServed();
              return stubWindow();
            };
            looksNative(w.open, 'open');
          } catch {}
        }
        return w;
      }
    });
    looksNative(Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow').get, 'get contentWindow');
  }

  // The frame chain relays postMessage blindly in both directions with no origin
  // check, so a click in the deepest player frame reaches the SDK on the top
  // page as an @@other-clicks-click command. Registered at document_start, this
  // listener runs before the SDK's and cuts the command out of the relay.
  // Player telemetry (play, pause, timeupdate) is left alone.
  addEventListener(
    'message',
    (e) => {
      if (!enabled) return;
      let cmd;
      try {
        const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        cmd = d && d.command;
      } catch {
        return;
      }
      if (typeof cmd === 'string' && cmd.indexOf('@@other-clicks-click') === 0) {
        e.stopImmediatePropagation();
        report('click-relay', cmd);
      }
    },
    true
  );

  // Popunder scripts re-register these on every navigation attempt.
  const killer = (name) => {
    try {
      Object.defineProperty(window, name, { get: () => null, set: () => {}, configurable: true });
    } catch {}
  };
  killer('onbeforeunload');

  function restore() {
    window.open = nativeOpen;
    HTMLAnchorElement.prototype.click = nativeAnchorClick;
    HTMLFormElement.prototype.submit = nativeSubmit;
    HTMLFormElement.prototype.requestSubmit = nativeRequestSubmit;
    Function.prototype.toString = nativeToString;
    if (frameDesc && frameDesc.get) Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', frameDesc);
  }
})();
