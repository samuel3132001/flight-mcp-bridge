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

const BRIDGE_URL   = 'ws://127.0.0.1:9223';
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
    } else if (tool === 'search_flights_multicity') {
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

// ─── Google Flights Airport/City Knowledge Graph IDs ─────────────────────────
const GF_AIRPORT_KG = {
  // Taiwan
  TPE: '/m/0ftkx',  TSA: '/m/07mbt',  KHH: '/m/0491p',
  // Japan
  TYO: '/m/07dfk',  NRT: '/m/0g284',  HND: '/m/013d6j',  OSA: '/m/05mzn',  KIX: '/m/042_p',  ITM: '/m/02844r',
  FUK: '/m/02m9y',  CTS: '/m/0733x',  OKA: '/m/07n_k',
  // Korea
  SEL: '/m/0h766',  ICN: '/m/03_96',  GMP: '/m/016_tk',  PUS: '/m/019qj',
  // Southeast Asia
  HKG: '/m/03h64',  BKK: '/m/01f08',  SIN: '/m/06t62',  KUL: '/m/04bdp',  SGN: '/m/03f6f',  HAN: '/m/03h64',
  // USA
  NYC: '/m/02_28',  JFK: '/m/042m7',  EWR: '/m/02p_f',  LGA: '/m/04fdy',
  SFO: '/m/0d6lp',  LAX: '/m/030qb3', SEA: '/m/0d9jr',  CHI: '/m/01_d4',  ORD: '/m/0f3_t',
  // Europe
  LON: '/m/04jpl',  LHR: '/m/04f_k',  PAR: '/m/05qtj',  CDG: '/m/0197n',  AMS: '/m/0k3p',   FRA: '/m/02_p5',
};

function gfAirport(iata) {
  const kg = GF_AIRPORT_KG[(iata || '').toUpperCase()];
  return kg ? { type: 2, code: kg } : { type: 1, code: iata.toUpperCase() };
}

/**
 * Build a Google Flights tfs= protobuf URL directly.
 * Precisely matched against user-provided working example.
 */
function buildGFTfsUrl(params) {
  console.log('[bg] buildGFTfsUrl params:', params);
  const { origin, destination, departure_date, return_date, passengers, cabin, legs } = params;

  const numPax = parseInt(passengers, 10) || 1;
  const cabinMap = { economy: 1, premium_economy: 2, business: 3, first: 4 };
  const cabinVal = cabinMap[(cabin || 'economy').toLowerCase()] || 1;

  function varint(n) {
    const b = [];
    let v = Number(n);
    while (v > 127) { b.push((v & 0x7f) | 0x80); v >>>= 7; }
    b.push(v & 0x7f);
    return b;
  }
  const enc = new TextEncoder();
  const str  = s => { const b = [...enc.encode(s)]; return [...varint(b.length), ...b]; };
  const tag  = (f, w) => varint((f << 3) | w);
  const fv   = (f, v) => [...tag(f, 0), ...varint(v)];
  const fs   = (f, s) => [...tag(f, 2), ...str(s)];
  const fm   = (f, inner) => { const b = inner.flat(); return [...tag(f, 2), ...varint(b.length), ...b]; };
  const apt  = (f, airport) => fm(f, [...fv(1, airport.type), ...fs(2, airport.code)]);
  const leg  = (date, from, to) => [...fs(2, date), ...apt(13, from), ...apt(14, to)];

  const bytes = [
    ...fv(1, 28),
    ...fv(2, 1),
  ];

  if (legs && Array.isArray(legs) && legs.length > 0) {
    for (const l of legs) {
      const o = gfAirport(l.origin);
      const d = gfAirport(l.destination);
      bytes.push(...fm(3, leg(l.date, o, d)));
    }
  } else {
    const o = gfAirport(origin);
    const d = gfAirport(destination);
    bytes.push(...fm(3, leg(departure_date, o, d)));
    if (return_date) {
      bytes.push(...fm(3, leg(return_date, d, o)));
    }
  }

  bytes.push(
    ...fv(8, numPax),
    ...fv(9, cabinVal),   // Legacy Cabin tag
    ...fv(11, cabinVal),  // Modern Cabin tag
    ...fv(12, 1),
    0x82, 0x01, 0x00,     // Empty Tag 16 (Options) to trigger search behavior
    ...fv(19, 1)
  );

  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `https://www.google.com/travel/flights/search?tfs=${b64}&tfu=EgYIAhAAGAA&curr=TWD&hl=zh-TW`;
}

function buildGoogleFlightsUrl(params) {
  return buildGFTfsUrl(params);
}

async function dispatchToGoogleFlights(action, params) {
  if (action === 'search') {
    const searchUrl = buildGoogleFlightsUrl(params);
    const tabs = await chrome.tabs.query({ url: GF_URL + '*' });
    let tab;

    if (tabs.length > 0) {
      tab = tabs[0];
      await chrome.tabs.update(tab.id, { url: searchUrl, active: true });
    } else {
      tab = await chrome.tabs.create({ url: searchUrl, active: true });
    }

    await waitForTabLoad(tab.id, 30000);
    await waitForFlightsReady(tab.id, 50000);

    await ensureContentScript(tab.id, 'content-gf.js');
    return await sendToContentScript(tab.id, { action: 'scrape', source: 'google-flights', params }, 55000);
  }

  if (action === 'scrape') {
    const tabs = await chrome.tabs.query({ url: GF_URL + '*' });
    if (tabs.length === 0) return { error: 'No Google Flights tab found. Run search_flights first.' };
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
          function allText(root) {
            let t = '';
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) t += node.nodeValue;
            for (const el of root.querySelectorAll('*')) if (el.shadowRoot) t += allText(el.shadowRoot);
            return t;
          }
          const fullText = allText(document.body);
          let hasResults = PRICE_RE.test(fullText) && TIME_RE.test(fullText) && !fullText.includes('起\n') && fullText.length > 2000;
          if (!hasResults) {
            const scripts = Array.from(document.querySelectorAll('script:not([src])'));
            const hasFlightScriptData = scripts.some(s => s.textContent.length > 5000 && /(?:0[6-9]|1\d|2[0-3]):[0-5]\d/.test(s.textContent) && PRICE_RE.test(s.textContent));
            if (hasFlightScriptData) hasResults = true;
          }
          const isLoading = !!document.querySelector('[aria-label*="載入中"], [aria-label*="Loading"], [aria-label*="loading"]');

          // Fallback: If no results and not loading, try to click Search button
          if (!hasResults && !isLoading) {
             const btn = Array.from(document.querySelectorAll('button')).find(b => 
               (b.textContent.includes('搜尋') || b.textContent.includes('Search')) && 
               b.offsetParent !== null &&
               b.getAttribute('aria-label') !== 'Google'
             );
             if (btn) btn.click();
          }

          return { hasResults, isLoading };
        }
      });
      if (result.result.hasResults && !result.result.isLoading) { await sleep(1500); return; }
    } catch { }
    await sleep(1000);
  }
}

// ─── ITA Matrix ───────────────────────────────────────────────────────────────

function buildITAUrl(params) {
  const { origin, destination, departure_date, return_date, passengers = 1 } = params;
  const slice = { origin: [origin], dest: [destination], dates: { searchDateType: 'specific', departureDate: departure_date, departureDateType: 'depart', departureDateModifier: '0', departureDatePreferredTimes: [], returnDateType: 'depart', returnDateModifier: '0', returnDatePreferredTimes: [] } };
  const search = { type: return_date ? 'round-trip' : 'one-way', slices: return_date ? [slice, { origin: [destination], dest: [origin], dates: { ...slice.dates, departureDate: return_date } }] : [slice], options: { cabin: 'COACH', stops: '-1', extraStops: '1', allowAirportChanges: 'true', showOnlyAvailable: 'true' }, pax: { adults: String(passengers) } };
  return `https://matrix.itasoftware.com/flights?search=${btoa(JSON.stringify(search))}`;
}

async function dispatchToITAMatrix(action, params) {
  const tabs = await chrome.tabs.query({ url: ITA_URL + '*' });
  let tab;
  if (action === 'search') {
    if (tabs.length === 0) { tab = await chrome.tabs.create({ url: ITA_URL, active: true }); await waitForTabLoad(tab.id, 20000); }
    else { tab = tabs[0]; const tabInfo = await chrome.tabs.get(tab.id); if (!tabInfo.url.includes('matrix.itasoftware.com/search') || tabInfo.url.includes('flights')) { await chrome.tabs.update(tab.id, { url: ITA_URL, active: true }); await waitForTabLoad(tab.id, 20000); } else { await chrome.tabs.update(tab.id, { active: true }); } }
    await waitForITAFormReady(tab.id, 15000);
    await ensureContentScript(tab.id, 'content-ita.js');
    return await sendToContentScript(tab.id, { action: 'search', source: 'ita-matrix', params }, 140000);
  }
  if (action === 'scrape') {
    if (tabs.length === 0) return { error: 'No ITA Matrix tab found. Run search_ita first.' };
    tab = tabs[0];
    await ensureContentScript(tab.id, 'content-ita.js');
    return await sendToContentScript(tab.id, { action: 'scrape', source: 'ita-matrix' }, 10000);
  }
}

async function waitForITAFormReady(tabId, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: () => ({ ready: document.querySelectorAll('input[placeholder="Add airport"]').length >= 2 }) });
      if (result.result.ready) return;
    } catch { }
    await sleep(500);
  }
}

function buildITAMulticityUrl(legs, passengers = 1) {
  const slices = legs.map(leg => ({ origin: [leg.origin], dest: [leg.destination], dates: { searchDateType: 'specific', departureDate: leg.date, departureDateType: 'depart', departureDateModifier: '0', departureDatePreferredTimes: [] } }));
  const search = { type: 'multi-city', slices, options: { cabin: 'COACH', stops: '-1', extraStops: '1', allowAirportChanges: 'true', showOnlyAvailable: 'true' }, pax: { adults: String(passengers || 1) } };
  return `${ITA_URL}flights?search=${btoa(JSON.stringify(search))}`;
}

async function dispatchToITAMulticity(legs, passengers = 1, cabin = 'economy') {
  const tabs = await chrome.tabs.query({ url: ITA_URL + '*' });
  let tab = tabs.length === 0 ? await chrome.tabs.create({ url: ITA_URL, active: true }) : tabs[0];
  if (tabs.length > 0) await chrome.tabs.update(tab.id, { url: ITA_URL, active: true });
  await waitForTabLoad(tab.id, 20000);
  await waitForITAFormReady(tab.id, 15000);
  await ensureContentScript(tab.id, 'content-ita.js');
  return await sendToContentScript(tab.id, { action: 'search', source: 'ita-matrix', params: { legs, passengers, cabin } }, 140000);
}

// ─── Content Script Utilities ─────────────────────────────────────────────────

async function ensureContentScript(tabId, scriptFile) {
  try { await new Promise((resolve, reject) => { chrome.tabs.sendMessage(tabId, { action: 'ping' }, (resp) => { if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message)); resolve(resp); }); }); }
  catch { console.log(`[bg] Injecting ${scriptFile}...`); await chrome.scripting.executeScript({ target: { tabId }, files: [scriptFile] }); await sleep(500); }
}

async function sendToContentScript(tabId, message, timeoutMs = 60000) {
  await chrome.tabs.update(tabId, { active: true });
  await sleep(300);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Content script response timeout')), timeoutMs);
        chrome.tabs.sendMessage(tabId, message, (response) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (response && response.error) return reject(new Error(response.error));
          resolve(response);
        });
      });
    } catch (err) {
      const isBfcacheErr = err.message.includes('back/forward cache') || err.message.includes('message channel closed') || err.message.includes('Could not establish connection');
      if (attempt === 0 && isBfcacheErr) {
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
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, timeoutMs);
    function listener(id, changeInfo) { if (id === tabId && changeInfo.status === 'complete') { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(timer); resolve(); } }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => { if (!chrome.runtime.lastError && tab.status === 'complete') { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(timer); resolve(); } });
  });
}

function setBadge(connected) { chrome.action.setBadgeText({ text: connected ? 'ON' : 'OFF' }); chrome.action.setBadgeBackgroundColor({ color: connected ? '#22c55e' : '#ef4444' }); }

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'get-status') { sendResponse({ connected: wsReady, url: BRIDGE_URL }); return true; }
  if (msg.type === 'reconnect') { backoffIdx = 0; if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } if (ws) ws.close(); else connect(); sendResponse({ ok: true }); return true; }
});

chrome.alarms.create(ALARM_NAME, { periodInMinutes: 25 / 60 });
chrome.alarms.onAlarm.addListener(({ name }) => { if (name !== ALARM_NAME) return; if (!wsReady) connect(); else if (ws && ws.readyState === WebSocket.OPEN) try { ws.send(JSON.stringify({ type: 'ping' })); } catch { } });

setBadge(false);
connect();
