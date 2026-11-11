const DEFAULT = 'https://clonereport.com';
const input = document.getElementById('apiBase');
const msg = document.getElementById('msg');

chrome.storage.sync.get({ apiBase: DEFAULT }).then(({ apiBase }) => { input.value = apiBase; });

async function save(value) {
  let url;
  try { url = new URL(value || DEFAULT); } catch { msg.textContent = 'Not a valid URL.'; return; }
  if (!/^https?:$/.test(url.protocol)) { msg.textContent = 'Use an http or https address.'; return; }
  const origin = `${url.protocol}//${url.hostname}/*`;
  if (url.hostname !== 'clonereport.com') {
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: [origin] }); }
    catch { msg.textContent = 'Only clonereport.com or a local server (localhost) can be used.'; return; }
    if (!granted) { msg.textContent = 'Permission denied for that site.'; return; }
  }
  const apiBase = url.href.replace(/\/+$/, '');
  await chrome.storage.sync.set({ apiBase });
  await chrome.storage.session.clear();
  input.value = apiBase;
  msg.textContent = 'Saved.';
}

document.getElementById('save').addEventListener('click', () => save(input.value.trim()));
document.getElementById('reset').addEventListener('click', () => save(DEFAULT));
