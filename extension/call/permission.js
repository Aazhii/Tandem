'use strict';

/** One-time camera/mic permission for the extension, requested from a normal tab (iframes can't always prompt). */

const status = document.getElementById('status');

async function ask() {
  status.className = '';
  status.textContent = 'Chrome will ask you now — choose “Allow”.';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    stream.getTracks().forEach((t) => t.stop());
    status.className = 'ok';
    status.textContent = '✓ All set! Going back to your video…';
    await chrome.runtime.sendMessage({ cmd: 'call_permission_granted' }).catch(() => {});
    setTimeout(async () => {
      const tab = await chrome.tabs.getCurrent();
      if (tab) chrome.tabs.remove(tab.id);
    }, 1200);
  } catch (err) {
    status.className = 'err';
    status.textContent = err && err.name === 'NotFoundError'
      ? 'No camera or microphone was found on this computer.'
      : 'Permission was blocked. Click the camera icon in the address bar, choose “Allow”, then press “Ask again”.';
  }
}

document.getElementById('retry').addEventListener('click', ask);
ask();
