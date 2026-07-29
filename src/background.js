const DEFAULTS = { debug: false, button: true };
const NET_RULE_BASE = 1000;

// Per-tab counters, lost when the worker sleeps. Only drives the badge.
const tabs = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const s = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set({ ...DEFAULTS, ...s });
});

// Protection is opt-in per tab. The set lives in session storage so it survives
// worker sleep but resets with the browser, same as the session net rules.
async function protectedTabs() {
  const { protectedTabs = [] } = await chrome.storage.session.get({ protectedTabs: [] });
  return protectedTabs;
}

// The static ruleset would block on every tab, so the blocklist ships as
// session rules pinned to the protected tabs instead.
async function syncNetRules(tabIds) {
  const old = await chrome.declarativeNetRequest.getSessionRules();
  const removeRuleIds = old.map((r) => r.id);
  let addRules = [];
  if (tabIds.length) {
    const rules = await (await fetch(chrome.runtime.getURL('rules/network.json'))).json();
    addRules = rules.map((r, i) => ({ ...r, id: NET_RULE_BASE + i, condition: { ...r.condition, tabIds } }));
  }
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
}

async function setProtected(tabId, on) {
  const list = await protectedTabs();
  const next = on ? [...new Set([...list, tabId])] : list.filter((id) => id !== tabId);
  await chrome.storage.session.set({ protectedTabs: next });
  await syncNetRules(next);
  if (!on) {
    tabs.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }
}

function bump(tabId, items) {
  const entry = tabs.get(tabId) || { count: 0, items: [] };
  entry.count += items.length;
  entry.items = items.concat(entry.items).slice(0, 40);
  tabs.set(tabId, entry);
  const text = entry.count > 999 ? '999+' : String(entry.count);
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#d92b2b' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'blocked' && sender.tab) {
    bump(sender.tab.id, msg.items || []);
    return;
  }
  // Content scripts wake up dormant and ask whether their tab is protected.
  // The CSS rides along here so only protected frames ever get it.
  if (msg.type === 'hello' && sender.tab) {
    const tabId = sender.tab.id;
    const frameId = sender.frameId;
    (async () => {
      const on = (await protectedTabs()).includes(tabId);
      if (on) {
        chrome.scripting
          .insertCSS({ target: { tabId, frameIds: [frameId] }, files: ['src/hide.css'] })
          .catch(() => {});
      }
      sendResponse(on);
    })();
    return true;
  }
  if (msg.type === 'getTab') {
    (async () => {
      const entry = tabs.get(msg.tabId) || { count: 0, items: [] };
      sendResponse({ ...entry, active: (await protectedTabs()).includes(msg.tabId) });
    })();
    return true;
  }
  if (msg.type === 'setActive') {
    const tabId = msg.tabId ?? (sender.tab && sender.tab.id);
    if (tabId == null) return;
    (async () => {
      await setProtected(tabId, !!msg.active);
      sendResponse(true);
    })();
    return true;
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'loading' || !info.url) return;
  tabs.delete(tabId);
  if ((await protectedTabs()).includes(tabId)) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#3f7dd9' }).catch(() => {});
    chrome.action.setBadgeText({ tabId, text: 'on' }).catch(() => {});
  } else {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  tabs.delete(tabId);
  if ((await protectedTabs()).includes(tabId)) setProtected(tabId, false);
});
