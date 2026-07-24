(() => {
  let enabled = true;

  // Storage reads are async, so block first and stand down if allowlisted.
  addEventListener('__gb_cfg', (e) => {
    enabled = !!(e.detail && e.detail.enabled);
    if (!enabled) restore();
  });

  // The SDK checks open.toString() for [native code] and routes around anything
  // patched, so every hook below has to keep reading as native.
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

  // A real link opens the href the user pressed. Popunders fire from a click
  // anywhere else on the page.
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

  // The SDK polls closed to see if the popunder landed. Reporting closed right
  // away tells it we blocked, and it retries by another route.
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

  // Their own cap is one impression per hour, so refreshing the stamp suppresses
  // the next attempt. Only touched when the key exists, never created.
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

  // The popunder path skips window.open: hidden form, target _blank, submit,
  // remove. Nothing legitimate submits a cross-site _blank form.
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

  // A fresh about:blank iframe has an untouched open, so patch each child realm
  // as the page reaches for it.
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
            // Throws for cross-origin realms, which are unreachable anyway.
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

  // The frame chain relays postMessage with no origin check, so a click in a
  // nested player frame reaches the SDK up here. Registered first, so it wins.
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

  // Popunders re-arm this on every navigation attempt.
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
