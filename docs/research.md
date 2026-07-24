# Ghostblock research notes

How the ad SDKs on two streaming sites actually work, and what each finding changed in the extension. This is the reasoning behind the rules in `src/content.js` and `src/main-world.js`.

Analysed July 2026. Sites change; treat specifics as a snapshot.

## What 123movies9.pro actually does

Analyzed 2026-07-24. The frame chain is `123movies9.pro` → `123movies9.bar/embed/...` → `cloudorchestranova.com/rcp/...` → player. The top page is almost clean: 2 iframes, no overlays. Everything hostile is one or two frames down, which is why `all_frames: true` matters.

**Popunder via form submit, not `window.open`.** `ub.fizzledesire.com/.../120183` is the ad SDK on the top page. It wraps `window.open` itself, but the actual popunder builds a `<form>`, sets `target="_blank"`, appends it, submits, and removes it. A `window.open` patch alone does nothing here. Handled by the `HTMLFormElement.prototype.submit` / `requestSubmit` patch.

**Click catcher in the rcp frame.** `<div id="pop_asdf" style="position:absolute; width:100%; height:100%; z-index:2147483650; pointer-events:none">`. It ships inert and `cloudnestra.com/asdf.js` flips `pointer-events` on to eat the first click on the player. Caught by the `z >= 1000000` rule, which fires before the flip. The SDK also builds its own fixed full-viewport layer at `z-index: 2147483640`.

**Link hijacking.** The SDK runs `document.querySelectorAll('a').forEach(...)`, calls `preventDefault` + `stopPropagation` on each, and reroutes through its own tracker with `step1=` / `step2=` params. It also intercepts video `play` / `pause` clicks.

**Anti-analysis.** `unpkg.com/disable-devtool@0.3.9`, plus `sbx.js`, a sandbox detector that redirects if the frame carries a `sandbox` attribute. The embed page also self-closes when opened as a top-level tab.

`cloudnestra.com` is blocked at `/asdf.js` only, not domain-wide, because the same host serves the player. `cloudorchestranova.com` is not blocked at all for the same reason.

## How the ads keep coming back

Five separate persistence mechanisms, which is why a one-shot cleanup never holds.

**1. A forever re-injection interval.** The SDK schedules its injector at `[0, 1000, 2500]` ms, then `setInterval(injector, 2500)` with no stop condition. It rebuilds its layer every 2.5s for as long as the tab is open. The first version of this extension swept for 20s and then stopped, so the ads simply won after that. The sweep is now permanent: 1s ticks for the first 30s, then a 5s backstop, with the MutationObserver catching injections in real time between ticks.

**2. No MutationObserver on their side.** The SDK never watches for removal of its own nodes, so hiding an element does not trigger an immediate rebuild. Only the interval brings it back, which the permanent sweep covers.

**3. Popup-success probing.** After opening a popunder it polls `popup.closed` every 100ms and reports how long it stayed open. A stub window that reports `closed: true` right away tells the SDK the block happened, and it retries by another route. The stub now reports open for 4s before closing, which reads as a served impression.

**4. Frequency capping in cookies and localStorage.** The rcp frame's `#pop_asdf` handler eats up to 3 clicks, re-arming itself 59s after each, then writes a `pop_asdf` cookie with a 3-hour expiry and stops. The SDK keeps its own counters under `fs_`, `fso_`, `st_prfrr_` and `edt`. That handler is commented out in the current build but the code path is intact, so the rules for it stay in.

Worth knowing: pre-seeding the `pop_asdf` cookie on that origin would make the layer disable itself, which is more durable than fighting the DOM. Not implemented, since the handler is currently inactive.

**5. A blind cross-frame relay.** The rcp frame forwards every `postMessage` in both directions with `'*'` and no origin check. The SDK rides it with `@@other-clicks-click-n` / `@@other-clicks-click-c` commands, so a click in the deepest player frame triggers the popunder up on the top page. The main-world script registers a `message` listener at `document_start`, before the SDK loads, and cuts those two commands out of the relay. Player telemetry (`play`, `pause`, `timeupdate`) rides the same channel and is deliberately left alone.

Also running: a `setInterval` that removes and recreates `<link rel="preconnect">` elements to keep the ad hosts warm. Dead once the domains are blocked at the network layer.

## The two escapes the SDK uses when it detects you

**Native-code detection.** The SDK runs `open.toString().includes('[native code]')` before every call. If `window.open` looks patched it does not use it at all: it creates an `about:blank` iframe styled `0x0, position:fixed, z-index:2147483640` with `!important`, calls **that realm's** clean `open`, and removes the iframe 1s later. It does the same to `Date.now` so its own frequency capping cannot be tampered with either.

Two counters: `Function.prototype.toString` is patched so every hooked function still reports `[native code]`, which keeps the SDK on the patched path. And `HTMLIFrameElement.prototype.contentWindow` is wrapped to patch each child realm's `open` the moment the page reaches for it. Cross-origin realms throw on access and are skipped, which is fine since they are unreachable anyway.

**Rotating domains.** The ad host is generated, not fixed: SHA-256 of `seed|YYYYMMDDHH` bucketed to 3 hours, base32-encoded into `subdomain.label`, with a random 10-24 char path segment. It builds a primary and a fallback host per bucket and injects a `<script>` with `onerror` falling through to the second.

So `rules/network.json` is a convenience, not the defense. `fizzledesire.com` is today's host and it will not be next week's. The durable layers are the API patches and the DOM classifier, which are domain-independent.

## Not breaking the player

The frame chain is nested and cross-origin at every hop, so by the `baseDomain` test the real player is "third-party" at every level. That makes it a candidate for the same rules that catch ad frames, and getting this wrong kills playback. Four structural guards:

1. **Nothing that is or wraps a large painted frame is ever touched.** `wrapsPlayer()` runs first in `classify()`. Player wrappers contain only an iframe, so `hasVisibleContent()` counts `iframe` / `embed` / `object` as content. Without that, a transparent wrapper holding just the player reads as an empty click catcher.
2. **Every frame rule waits for layout** (`mature`). Before layout a frame measures 0x0 and computes as hidden. Judging a player in that window kills it on every single load.
3. **`everLarge`**: a frame seen at player size once is exempt permanently. Players get hidden and reshown for loading states and quality switches, and must not become eligible during the hidden moment.
4. **`src` is only blanked for zero-size tracker frames.** Blanking cannot be undone without a reload, so everything else is merely hidden.

Verified on the live episode page: the classifier flags 0 elements there and identifies the player iframe as content. That only covers the top frame. The nested frames could not be checked live, since the embed page self-closes when opened as a top-level tab.

If the player still dies, open the popup: the block list names the exact element and rule that fired.

## Live observation, and what it changes

Watched the episode page for ~10s with a MutationObserver on everything, plus hooks on `window.open`, `form.submit`, `location.assign/replace/reload` and `message`.

**Nothing was injected. No overlays, no frames, no forms, no navigation.** The SDK script (`ub.fizzledesire.com/...`) was confirmed loaded the whole time.

So on this site the ad layer is **armed and click-triggered, not timer-painted**. A scanner that only looks at the DOM on a quiet page finds nothing to remove. The defenses that actually matter here are the click-time ones: the form-submit and `window.open` patches, the `@@other-clicks-click` message filter, and the pointerdown shield. The DOM sweep is the backstop for the layers that do get painted (`#pop_asdf`, `#ad720`), not the main event.

The 2.5s re-injection interval is real in the SDK source but produced no DOM nodes in this window, so it is gated behind config, geo/timezone, or the frequency cap. The permanent sweep stays, since it costs almost nothing and covers the case where the gate opens.

**Negative results worth recording** (checked, genuinely absent):

- No `serviceWorker.register`, `Notification.requestPermission`, or `PushManager` anywhere in the chain. Push-notification ad spam is not a vector on this site.
- No ad markup on the top page. The `ad`/`banner` class matches there are navigation elements (`head-main-nav`, `advc-menu`), all statically positioned, so the classifier ignores them.
- No in-place `href` rewriting on the page's 200 links.

**Dormant slot**: the embed page still ships the `#ad720` handler with no matching markup. Its close button sets a cookie at `expires: 0.001` days, so closing that banner buys about 86 seconds. Added to `hide.css` for when it comes back.

**Other extensions**: Grammarly parks a custom element at `z-index: 2147483646`, right in the range the max-z rule targets. Elements with a hyphen in the tag name are now skipped, since ad injectors use plain `div` / `a` / `iframe` / `ins` and a custom element is somebody else's UI.

**Source switching is the real player-breaking risk.** `sources.js` handles server/source clicks by emptying `#the_frame` and appending a brand new `cloudnestra.com/rcp/<hash>` iframe. That frame is third-party, dynamically created, and unmeasured at insertion, which is exactly the shape the old zero-size rule would have blanked. This is the most likely cause of the player dying mid-session. The `mature` gate and `everLarge` exemption both cover it.

## gokutv.net

Same SDK vendor as 123movies, plus a second network.

- **`lb.acoupfoughty.com/<random>/<zone>`** is the same codebase as `ub.fizzledesire.com`, a newer and larger build (136 KB vs 55 KB). Same `@@other-clicks-click` relay, same hidden-form popunder (`createElement('form')`, `target=_blank`, `display:none`, submit, remove), same native-code check with the `about:blank` iframe-realm fallback. Every patch written for 123movies applies unchanged. It returns `{closed: false}` from its own fake window, which confirms the stub's 4s open window is the right shape.
- It carries a creative layer with three z-index tiers (`2147483648` / `2147483647` / `2147483646`, all `position: fixed`) and a 28px round close button. All above the `z >= 1000000` threshold.
- Seven `getTimezoneOffset` calls: the ad is geo/timezone gated, which is why a passive page can sit quiet.
- **`pubinstancesglorious.com/<32-hex>/invoke.js`** is Adsterra's native banner loader, string-array obfuscated so plaintext greps find nothing. The `/<32-hex>/invoke.js` path shape is stable across their rotating domains, so rule 9 matches it with a `regexFilter` instead of a hostname.

Live: homepage and a movie page both stayed quiet for 10s. No injected nodes, no popup attempts, no frames on the homepage. Click-triggered, same as 123movies.

## Two false positives this site exposed

Both found by running the classifier against a real movie page, and both would have looked like "the extension broke the site".

**1. The closed-modal pattern.** gokutv's trailer modal is:

```css
.Modal-Box { position: fixed; width: 100%; height: 100%; visibility: hidden; opacity: 0 }
.Modal-Box.on { visibility: visible; opacity: 1 }
```

A closed modal is still laid out at full viewport size with `opacity: 0`, which is exactly the transparent-full-page-click-catcher signature. Worse, the fix is `display: none !important` set inline, so adding `.on` can never reveal it again — the trailer was permanently dead. This is a stock CSS modal pattern, so it would have broken modals and lightboxes on many sites.

Fixed on principle: **`visibility: hidden` and `display: none` elements cannot receive a click, so they cannot be catching one.** They are now skipped by the overlay rules. `opacity: 0` alone stays a threat, since those do take clicks.

**2. A full-bleed backdrop `<img>`.** `img.TPostBg` (1455x596, absolutely positioned) was flagged as a click catcher. `hasVisibleContent()` only looked for visible content *inside* an element, and an `<img>` has no descendants and no text. An element that **is** an image is now visible content.

Also raised `PLAYER_MIN` to 400x225, above the common ad rectangles (300x250, 336x280, 728x90), so a banner wrapper is not mistaken for a player. And `wrapsPlayer()` no longer requires the frame to be currently painted, since a closed trailer modal lays its player out at full size.

After both fixes the classifier flags **0** elements on that movie page, and the modal and backdrop both pass.

## Verification

Tested by planting ad-shaped decoys on a live page and checking both that they get caught and that real site UI does not.

On **gokutv.net/movies/con-city/**, all four decoys were neutralized and both previously-broken elements survived:

| Decoy | Result |
|---|---|
| `position:fixed; inset:0; z-index:2147483650` transparent layer | `max z-index ad layer` |
| 1x1 third-party iframe | `zero-size third-party frame` |
| Off-screen third-party iframe | `zero-size third-party frame` |
| Full-viewport empty cross-site `<a>` | `transparent full-page click catcher` |
| **`.Modal-Box` trailer modal** | **untouched, inline style clean** |
| **`img.TPostBg` backdrop** | **untouched** |

Nothing else on the page was marked, so zero false positives.

**123movies9.pro was not verified.** It is sitting in the allowlist from an on-page-button click made while setting up an earlier test, so the content script is inert there. Clearing it needs `chrome.storage`, which page scripts cannot reach. Fix it in one click: open the popup on that site and turn **Allow this site** off.

Note the coordinate trap when driving the on-page button with automation: the click space and the page's CSS pixel space differ by the device pixel ratio.
