const $ = (id) => document.getElementById(id);

let tab, host;

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  host = tab && tab.url && /^https?:/.test(tab.url) ? new URL(tab.url).hostname.replace(/^www\./, '') : '';
  $('site').textContent = host || 'not a web page';
  $('site').title = host;

  const s = await chrome.storage.local.get({ enabled: true, debug: false, button: true, allowlist: [] });
  $('enabled').checked = s.enabled;
  $('debug').checked = s.debug;
  $('button').checked = s.button;
  $('allow').checked = s.allowlist.includes(host);
  if (!host) $('allowRow').classList.add('disabled');

  const info = await chrome.runtime.sendMessage({ type: 'getTab', tabId: tab.id });
  $('n').textContent = info.count;
  $('n').classList.toggle('hot', info.count > 0);
  render(info.items);
}

function render(items) {
  if (!items || !items.length) return;
  const box = $('list');
  box.textContent = '';
  for (const it of items) {
    const d = document.createElement('div');
    d.className = 'item';
    const b = document.createElement('b');
    b.textContent = it.reason;
    const i = document.createElement('i');
    i.textContent = it.tag + (it.id ? '#' + it.id : '') + (it.cls ? ' ' + it.cls : '');
    d.append(b, i);
    box.append(d);
  }
}

const persist = (patch) => chrome.storage.local.set(patch).then(() => chrome.tabs.reload(tab.id));

$('enabled').onchange = (e) => persist({ enabled: e.target.checked });
$('debug').onchange = (e) => persist({ debug: e.target.checked });
$('button').onchange = (e) => persist({ button: e.target.checked });

$('allow').onchange = async (e) => {
  const { allowlist } = await chrome.storage.local.get({ allowlist: [] });
  const next = e.target.checked ? [...new Set([...allowlist, host])] : allowlist.filter((h) => h !== host);
  await chrome.storage.local.set({ allowlist: next });
  await chrome.runtime.sendMessage({ type: 'allowlistChanged', allowlist: next });
  chrome.tabs.reload(tab.id);
};

$('rescan').onclick = () => chrome.tabs.sendMessage(tab.id, { type: 'rescan' }).catch(() => {});

init();
