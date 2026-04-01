'use strict';

const dot          = document.getElementById('dot');
const statusText   = document.getElementById('statusText');
const reconnectBtn = document.getElementById('reconnectBtn');

function setStatus(connected) {
  if (connected) {
    dot.classList.add('connected');
    statusText.textContent = 'Connected';
    statusText.classList.add('connected');
  } else {
    dot.classList.remove('connected');
    statusText.textContent = 'Disconnected';
    statusText.classList.remove('connected');
  }
}

// Get current status from background
chrome.runtime.sendMessage({ type: 'get-status' }, (response) => {
  if (chrome.runtime.lastError) return;
  if (response) setStatus(response.connected);
});

// Listen for live updates while popup is open
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status') setStatus(msg.connected);
});

reconnectBtn.addEventListener('click', () => {
  reconnectBtn.textContent = 'Reconnecting…';
  reconnectBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'reconnect' }, () => {
    setTimeout(() => {
      reconnectBtn.textContent = 'Reconnect';
      reconnectBtn.disabled = false;
    }, 2000);
  });
});
