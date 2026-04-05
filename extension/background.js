/**
 * Flight MCP Bridge — Background Service Worker (MV3)
 *
 * Responsibilities:
 * - Maintain a WebSocket connection to the local bridge (ws://127.0.0.1:9222)
 * - Dispatch incoming tool calls to the appropriate content script
 * - Return results back to the bridge
 * - Show connection status badge
 * - Keepalive via chrome.alarms (25s interval)
 */

'use strict';

const BRIDGE_URL   = 'ws://127.0.0.1:9222';
const ALARM_NAME   = 'flight-mcp-keepalive';
const BACKOFFS     = [1000, 2000, 5000, 10000, 30000];

const GF_URL  = 'https://www.google.com/travel/flights';
const ITA_URL = 'https://matrix.itasoftware.com/';

// ─── State ────────────────────────────────────────────────────────────────────

let ws            = null;
let wsReady       = false;
let backoffIdx    = 0;
let reconnectTimer = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Connection ───────────────────────────────────────────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try {
    ws = new WebSocket(BRIDGE_URL);
  } catch (err) {
    console.error('[bg] WebSocket construction failed:', err);
    scheduleReconnect();
    return;
  }

  ws.addEventListener('open', () => {
    console.log('[bg] Connected to bridge');
    wsReady = true;
    backoffIdx = 0;
    setBadge(true);
    notifyPopup({ type: 'status', connected: true });
  });

  ws.addEventListener('message', ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    handleToolCall(msg);
  });

  ws.addEventListener('close', () => {
    console.log('[bg] Disconnected from bridge');
    wsReady = false;
    ws = null;
    setBadge(false);
    notifyPopup({ type: 'status', connected: false });
    scheduleReconnect();
  });

  ws.addEventListener('error', (err) => {
    console.error('[bg] WS error:', err);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = BACKOFFS[Math.min(backoffIdx, BACKOFFS.length - 1)];
  backoffIdx++;
  console.log(`[bg] Reconnecting in ${delay}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ─── Tool Dispatch ────────────────────────────────────────────────────────────

async function handleToolCall({ requestId, tool, params }) {
  if (!requestId || !tool) return;

  try {
    let result;
    if (tool === 'search_flights') {
      result = await dispatchToGoogleFlights('search', params);
    } else if (tool === 'scrape_results') {
      result = await dispatchToGoogleFlights('scrape', params);
    } else if (tool === 'search_ita') {
      result = await dispatchToITAMatrix('search', params);
    } else if (tool === 'search_ita_multicity') {
      result = await dispatchToITAMulticity(params.legs, params.passengers, params.cabin);
    } else if (tool === 'scrape_ita_results') {
      result = await dispatchToITAMatrix('scrape', params);
    } else {
      throw new Error(`Unknown tool: ${tool}`);
    }
    send({ requestId, result });
  } catch (err) {
    console.error('[bg] Tool error:', err);
    send({ requestId, error: err.message });
  }
}

// ─── Google Flights ───────────────────────────────────────────────────────────

// ─── Google Flights Airport Encoding ─────────────────────────────────────────
// Confirmed Freebase/Knowledge Graph IDs (type=2 in tfs= protobuf).
// Any airport NOT listed here falls back to plain IATA code (type=1).
const GF_AIRPORT_KG = {
  // Taiwan (confirmed from real GF URLs)
  TPE: '/m/0ftkx',
  // Japan (confirmed)
  NRT: '/m/0g284', HND: '/m/013d6j',
};

/**
 * Return { type, code } for a given IATA code.
 * type=2 + KG ID for confirmed airports; type=1 + IATA string as fallback.
 */
function gfAirport(iata) {
  const kg = GF_AIRPORT_KG[(iata || '').toUpperCase()];
  return kg
    ? { type: 2, code: kg }
    : { type: 1, code: iata.toUpperCase() };
}

/**
 * Build a Google Flights tfs= protobuf URL directly.
 * Reverse-engineered from real GF URLs — avoids all form filling.
 * Always returns a URL (IATA fallback for unknown airports).
 */
function buildGFTfsUrl(params) {
  const { origin, destination, departure_date, return_date } = params;
  const o = gfAirport(origin);
  const d = gfAirport(destination);

  // Minimal protobuf encoder (varint + length-delimited)
  function varint(n) {
    const b = [];
    while (n > 127) { b.push((n & 0x7f) | 0x80); n >>>= 7; }
    b.push(n & 0x7f);
    return b;
  }
  const enc = new TextEncoder();
  const str  = s => { const b = [...enc.encode(s)]; return [...varint(b.length), ...b]; };
  const tag  = (f, w) => varint((f << 3) | w);
  const fv   = (f, v) => [...tag(f, 0), ...varint(v)];
  const fs   = (f, s) => [...tag(f, 2), ...str(s)];
  const fm   = (f, inner) => { const b = inner.flat(); return [...tag(f, 2), ...varint(b.length), ...b]; };
  // Airport submessage: field 1 = type (1=IATA, 2=KG), field 2 = code string
  const apt  = (f, airport) => fm(f, [...fv(1, airport.type), ...fs(2, airport.code)]);
  // Leg: field 2 = date, field 13 = origin airport, field 14 = dest airport
  const leg  = (date, from, to) => [...fs(2, date), ...apt(13, from), ...apt(14, to)];

  const bytes = [
    ...fv(1, 28),
    // field 2: trip type — 1=one-way, 2=round-trip
    ...fv(2, return_date ? 2 : 1),
    ...fm(3, leg(departure_date, o, d)),
    ...(return_date ? fm(3, leg(return_date, d, o)) : []),
    ...fv(8, 1), ...fv(9, 1), ...fv(14, 1),
    // field 16: { field_1: maxUint64 } — fixed search-options blob
    0x82, 0x01, 0x0b, 0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
    ...fv(19, 1),
  ];

  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // Use /search path (confirmed from real GF URLs)
  return `https://www.google.com/travel/flights/search?tfs=${b64}`;
}

function buildGoogleFlightsUrl(params) {
  return buildGFTfsUrl(params);
}

async function dispatchToGoogleFlights(action, params) {
  if (action === 'search') {
    // Navigate directly to the search URL — bypasses form filling entirely
    const searchUrl = buildGoogleFlightsUrl(params);
    const tabs = await chrome.tabs.query({ url: GF_URL + '*' });
    let tab;

    if (tabs.length > 0) {
      tab = tabs[0];
      await chrome.tabs.update(tab.id, { url: searchUrl, active: true });
    } else {
      tab = await chrome.tabs.create({ url: searchUrl, active: true });
    }

    // Wait for initial page load, then wait for flight result cards to appear
    await waitForTabLoad(tab.id, 30000);
    await waitForFlightsReady(tab.id, 50000);

    await ensureContentScript(tab.id, 'content-gf.js');
    return await sendToContentScript(
      tab.id,
      { action: 'scrape', source: 'google-flights', params },
      55000
    );
  }

  if (action === 'scrape') {
    const tabs = await chrome.tabs.query({ url: GF_URL + '*' });
    if (tabs.length === 0) {
      return { error: 'No Google Flights tab found. Run search_flights first.' };
    }
    const tab = tabs[0];
    await ensureContentScript(tab.id, 'content-gf.js');
    return await sendToContentScript(tab.id, { action: 'scrape', source: 'google-flights' });
  }
}

async function waitForFlightsReady(tabId, timeoutMs = 50000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const PRICE_RE = /(?:NT\$|TWD\s*|\$)\s*[\d,]{3,}/;
          const TIME_RE  = /\d{1,2}:\d{2}/;

          // Collect text from all elements including open Shadow DOM
          function allText(root) {
            let t = '';
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) t += node.nodeValue;
            for (const el of root.querySelectorAll('*')) {
              if (el.shadowRoot) t += allText(el.shadowRoot);
            }
            return t;
          }

          const fullText = allText(document.body);
          // Strategy 1: rendered flight cards (price + time, no 起)
          let hasResults = PRICE_RE.test(fullText) && TIME_RE.test(fullText)
            && !fullText.includes('起\n') && fullText.length > 2000;

          // Strategy 2: flight data embedded in script tags
          if (!hasResults) {
            const scripts = Array.from(document.querySelectorAll('script:not([src])'));
            const hasFlightScriptData = scripts.some(s =>
              s.textContent.length > 5000 &&
              /(?:0[6-9]|1\d|2[0-3]):[0-5]\d/.test(s.textContent) &&
              PRICE_RE.test(s.textContent)
            );
            if (hasFlightScriptData) hasResults = true;
          }

          const isLoading = !!document.querySelector(
            '[aria-label*="載入中"], [aria-label*="Loading"], [aria-label*="loading"]'
          );
          return {
            hasResults, isLoading,
            htmlLen: document.body.innerHTML.length,
            textLen: fullText.length,
          };
        }
      });
      if (result.result.hasResults && !result.result.isLoading) {
        await sleep(1500);
        return;
      }
    } catch { /* page still loading */ }
    await sleep(1000);
  }
  // Timeout — let scrape report what's actually there
}

// ─── ITA Matrix ───────────────────────────────────────────────────────────────

function buildITAUrl(params) {
  const { origin, destination, departure_date, return_date, passengers = 1 } = params;

  const slice = {
    origin: [origin],
    dest: [destination],
    dates: {
      searchDateType: 'specific',
      departureDate: departure_date,
      departureDateType: 'depart',
      departureDateModifier: '0',
      departureDatePreferredTimes: [],
      returnDateType: 'depart',
      returnDateModifier: '0',
      returnDatePreferredTimes: []
    }
  };

  const search = {
    type: return_date ? 'round-trip' : 'one-way',
    slices: return_date
      ? [slice, { origin: [destination], dest: [origin], dates: { ...slice.dates, departureDate: return_date } }]
      : [slice],
    options: {
      cabin: 'COACH',
      stops: '-1',
      extraStops: '1',
      allowAirportChanges: 'true',
      showOnlyAvailable: 'true'
    },
    pax: { adults: String(passengers) }
  };

  const encoded = btoa(JSON.stringify(search));
  return `https://matrix.itasoftware.com/flights?search=${encoded}`;
}

async function dispatchToITAMatrix(action, params) {
  const tabs = await chrome.tabs.query({ url: ITA_URL + '*' });
  let tab;

  if (action === 'search') {
    if (tabs.length === 0) {
      tab = await chrome.tabs.create({ url: ITA_URL, active: true });
      await waitForTabLoad(tab.id, 20000);
    } else {
      tab = tabs[0];
      // Always return to /search so Angular form is available
      const tabInfo = await chrome.tabs.get(tab.id);
      if (!tabInfo.url.includes('matrix.itasoftware.com/search') || tabInfo.url.includes('flights')) {
        await chrome.tabs.update(tab.id, { url: ITA_URL, active: true });
        await waitForTabLoad(tab.id, 20000);
      } else {
        await chrome.tabs.update(tab.id, { active: true });
      }
    }

    // Wait for Angular form to be ready
    await waitForITAFormReady(tab.id, 15000);
    await ensureContentScript(tab.id, 'content-ita.js');

    // Content script fills the form, clicks Search, waits for SPA navigation + results
    // Angular's own router does pushState navigation, keeping content script alive
    return await sendToContentScript(
      tab.id,
      { action: 'search', source: 'ita-matrix', params },
      82000   // stay under 90s MCP timeout
    );
  }

  if (action === 'scrape') {
    if (tabs.length === 0) {
      return { error: 'No ITA Matrix tab found. Run search_ita first.' };
    }
    tab = tabs[0];
    await ensureContentScript(tab.id, 'content-ita.js');
    return await sendToContentScript(tab.id, { action: 'scrape', source: 'ita-matrix' }, 10000);
  }
}

async function waitForITAFormReady(tabId, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const inputs = document.querySelectorAll('input[placeholder="Add airport"]');
          return { ready: inputs.length >= 2 };
        }
      });
      if (result.result.ready) return;
    } catch { /* still loading */ }
    await sleep(500);
  }
}

function buildITAMulticityUrl(legs, passengers = 1) {
  const slices = legs.map(leg => ({
    origin: [leg.origin],
    dest:   [leg.destination],
    dates: {
      searchDateType: 'specific',
      departureDate: leg.date,
      departureDateType: 'depart',
      departureDateModifier: '0',
      departureDatePreferredTimes: []
    }
  }));

  const search = {
    type: 'multi-city',
    slices,
    options: {
      cabin: 'COACH',
      stops: '-1',
      extraStops: '1',
      allowAirportChanges: 'true',
      showOnlyAvailable: 'true'
    },
    pax: { adults: String(passengers || 1) }
  };

  return `${ITA_URL}flights?search=${btoa(JSON.stringify(search))}`;
}

async function dispatchToITAMulticity(legs, passengers = 1, cabin = 'economy') {
  // Always navigate to a fresh ITA Matrix page so no stale form data remains.
  const tabs = await chrome.tabs.query({ url: ITA_URL + '*' });
  let tab;

  if (tabs.length === 0) {
    tab = await chrome.tabs.create({ url: ITA_URL, active: true });
  } else {
    tab = tabs[0];
    await chrome.tabs.update(tab.id, { url: ITA_URL, active: true });
  }
  await waitForTabLoad(tab.id, 20000);

  await waitForITAFormReady(tab.id, 15000);
  await ensureContentScript(tab.id, 'content-ita.js');
  return await sendToContentScript(
    tab.id,
    { action: 'search', source: 'ita-matrix', params: { legs, passengers, cabin } },
    82000
  );
}

async function waitForGFFormReady(tabId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // Must find a VISIBLE input (not DIV) with a flight-form aria-label
          const el = Array.from(document.querySelectorAll('input[aria-label][type="text"]'))
            .find(el => el.offsetParent !== null);
          return { ready: !!el };
        }
      });
      if (result.result.ready) return;
    } catch { /* still loading */ }
    await sleep(500);
  }
}

async function waitForITAReady(tabId, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // Wait for results: price elements or a loading indicator disappearing
          const prices = document.body?.innerText?.match(/\$[\d,]+/g) || [];
          const loading = document.querySelector('[class*="loading"], [class*="spinner"], [aria-label*="Loading"]');
          return { hasPrices: prices.length >= 2, isLoading: !!loading, priceCount: prices.length };
        }
      });
      if (result.result.hasPrices && !result.result.isLoading) {
        await sleep(500);
        return;
      }
      console.log(`[bg] ITA: waiting for results (${result.result.priceCount} prices, loading=${result.result.isLoading})`);
    } catch { /* page still loading */ }
    await sleep(1000);
  }
}

// ─── Content Script Utilities ─────────────────────────────────────────────────

/**
 * Ensure content script is alive in the tab.
 * Sends a ping; if it fails (e.g. after bfcache restore), re-injects the script.
 */
async function ensureContentScript(tabId, scriptFile) {
  try {
    await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { action: 'ping' }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(resp);
      });
    });
  } catch {
    console.log(`[bg] Injecting ${scriptFile}...`);
    await chrome.scripting.executeScript({ target: { tabId }, files: [scriptFile] });
    await sleep(500);
  }
}

/**
 * Send a message to a content script.
 * Activates the tab first (prevents bfcache from killing the channel).
 * On failure due to bfcache/connection errors, re-injects and retries once.
 */
async function sendToContentScript(tabId, message, timeoutMs = 60000) {
  // Bring tab to foreground to evict it from bfcache
  await chrome.tabs.update(tabId, { active: true });
  await sleep(300);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Content script response timeout')),
          timeoutMs
        );
        chrome.tabs.sendMessage(tabId, message, (response) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }
          if (response && response.error) {
            return reject(new Error(response.error));
          }
          resolve(response);
        });
      });
    } catch (err) {
      const isBfcacheErr =
        err.message.includes('back/forward cache') ||
        err.message.includes('message channel closed') ||
        err.message.includes('Could not establish connection');

      if (attempt === 0 && isBfcacheErr) {
        console.log('[bg] Content script lost, re-injecting...');
        const scriptFile = message.source === 'ita-matrix' ? 'content-ita.js' : 'content-gf.js';
        await chrome.scripting.executeScript({ target: { tabId }, files: [scriptFile] });
        await sleep(500);
        continue;
      }
      throw err;
    }
  }
}

function waitForTabLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);

    // Also check current status in case it's already complete
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

// ─── Badge ────────────────────────────────────────────────────────────────────

function setBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? 'ON' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({ color: connected ? '#22c55e' : '#ef4444' });
}

// ─── Popup communication ──────────────────────────────────────────────────────

function notifyPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {
    // Popup not open — ignore
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'get-status') {
    sendResponse({ connected: wsReady, url: BRIDGE_URL });
    return true;
  }
  if (msg.type === 'reconnect') {
    backoffIdx = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.close();
    } else {
      connect();
    }
    sendResponse({ ok: true });
    return true;
  }
});

// ─── Keepalive Alarm ──────────────────────────────────────────────────────────

chrome.alarms.create(ALARM_NAME, { periodInMinutes: 25 / 60 }); // every 25 seconds

chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name !== ALARM_NAME) return;
  if (!wsReady) {
    connect();
  } else if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

setBadge(false);
connect();
