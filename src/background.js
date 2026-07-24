const DEFAULTS = { enabled: true, debug: false, allowlist: [] };
const ALLOW_RULE_BASE = 10000;

// Per-tab counters, lost when the worker sleeps. Only drives the badge.
const tabs = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const s = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set({ ...DEFAULTS, ...s });
  syncAllowRules(s.allowlist || []);
});

chrome.runtime.onStartup.addListener(async () => {
  const { allowlist = [] } = await chrome.storage.local.get(DEFAULTS);
  syncAllowRules(allowlist);
});

async function syncAllowRules(list) {
  const old = await chrome.declarativeNetRequest.getSessionRules();
  const removeRuleIds = old.filter((r) => r.id >= ALLOW_RULE_BASE).map((r) => r.id);
  const addRules = list.map((host, i) => ({
    id: ALLOW_RULE_BASE + i,
    priority: 100,
    action: { type: 'allowAllRequests' },
    condition: { requestDomains: [host], resourceTypes: ['main_frame', 'sub_frame'] }
  }));
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
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
  if (msg.type === 'getTab') {
    sendResponse(tabs.get(msg.tabId) || { count: 0, items: [] });
    return true;
  }
  if (msg.type === 'allowlistChanged') {
    syncAllowRules(msg.allowlist || []);
    return;
  }
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) {
    tabs.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));
