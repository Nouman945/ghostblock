const $ = (id) => document.getElementById(id);

let tab, host;

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  host = tab && tab.url && /^https?:/.test(tab.url) ? new URL(tab.url).hostname.replace(/^www\./, '') : '';
  $('site').textContent = host || 'not a web page';
  $('site').title = host;

  const s = await chrome.storage.local.get({ debug: false, button: true });
  $('debug').checked = s.debug;
  $('button').checked = s.button;

  const info = await chrome.runtime.sendMessage({ type: 'getTab', tabId: tab.id });
  $('enabled').checked = info.active;
  if (!host) $('enabledRow').classList.add('disabled');
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

$('enabled').onchange = async (e) => {
  await chrome.runtime.sendMessage({ type: 'setActive', tabId: tab.id, active: e.target.checked });
  chrome.tabs.reload(tab.id);
};

$('debug').onchange = (e) => persist({ debug: e.target.checked });
$('button').onchange = (e) => persist({ button: e.target.checked });

$('rescan').onclick = () => chrome.tabs.sendMessage(tab.id, { type: 'rescan' }).catch(() => {});

init();
