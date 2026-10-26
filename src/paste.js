// Entry point for images Pin did not capture itself. Hands the image to the
// service worker, which stores it and starts the very same overlay flow used for
// tab captures — the crop, title, description, label, and submit UI is reused.

const drop = document.getElementById('drop');
const err = document.getElementById('err');

function fail(text) { err.textContent = text; }

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

async function accept(file) {
  if (!file) { fail('No image found — copy a screenshot and try again.'); return; }
  if (!file.type.startsWith('image/')) { fail(`That is a ${file.type || 'unknown'} file, not an image.`); return; }

  fail('');
  try {
    const dataUrl = await readAsDataUrl(file);
    const res = await chrome.runtime.sendMessage({ type: 'PIN_PASTE', dataUrl });
    // The worker replies, then messages this tab back to open the overlay.
    if (!res?.ok) fail(res?.error || 'Could not start the report.');
  } catch (e) {
    fail(String(e?.message || e));
  }
}

// 1. Clipboard
window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (!item) { fail('The clipboard has no image on it.'); return; }
  e.preventDefault();
  accept(item.getAsFile());
});

// 2. Drag and drop
for (const type of ['dragenter', 'dragover']) {
  drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('over'); });
}
for (const type of ['dragleave', 'drop']) {
  drop.addEventListener(type, () => drop.classList.remove('over'));
}
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  accept(e.dataTransfer?.files?.[0]);
});

// 3. File picker
document.getElementById('pick').addEventListener('click', () => document.getElementById('file').click());
document.getElementById('file').addEventListener('change', (e) => accept(e.target.files?.[0]));

window.addEventListener('DOMContentLoaded', () => window.focus());
