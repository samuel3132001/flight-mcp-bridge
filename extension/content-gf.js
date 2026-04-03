/**
 * Flight MCP Bridge — Google Flights Content Script
 *
 * Handles:
 *   action: "scrape"  — scrape current page for flight data
 *   action: "ping"    — liveness check
 *
 * Navigation is handled by background.js to avoid the bfcache/channel-closed bug:
 * when the content script does window.location.href = url, the page unloads and
 * the async message channel is never resolved.
 */

(function () {
  'use strict';

  // Remove any stale listener from a previous injection (e.g. after extension reload)
  if (window.__flightMcpGfListener) {
    chrome.runtime.onMessage.removeListener(window.__flightMcpGfListener);
  }

  // ─── Selectors (multi-layer fallback) ─────────────────────────────────────

  const FLIGHT_ROW_SELECTORS = [
    '.sMnRwf',   // current (2026)
    'li[data-ved]',
    '[role="listitem"]',
    '[jscontroller][data-ved]',
    '.pIav2d',
    '.gws-flights-results__result-item',
  ];

  const PRICE_SELECTORS = [
    '.AdWm1c',   // current (2026)
    '[data-gs]',
    '[aria-label*="$"]',
    '[aria-label*="NT$"]',
    '.YMlIz',
    '.priceText',
    '.gws-flights-results__itinerary-price',
    'span[role="text"]'
  ];

  const AIRLINE_SELECTORS = [
    '.Ir0Voe .sSHqwe',
    '[data-airline]',
    '.h1fkLb',
    '.carrier-name',
    '.gws-flights-results__carriers'
  ];

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function qs(el, selectors) {
    for (const s of selectors) {
      const found = el.querySelector(s);
      if (found) return found;
    }
    return null;
  }

  function qsAll(el, selectors) {
    for (const s of selectors) {
      const found = el.querySelectorAll(s);
      if (found.length > 0) return Array.from(found);
    }
    return [];
  }

  function getText(el, selectors) {
    const node = qs(el, selectors);
    return node ? node.textContent.trim() : null;
  }

  // ─── CAPTCHA / Error Detection ────────────────────────────────────────────

  function detectCaptcha() {
    if (document.querySelector('#captcha-form')) return true;
    if (document.querySelector('iframe[src*="recaptcha"]')) return true;
    const body = document.body.innerText || '';
    if (/unusual traffic|robot|captcha/i.test(body)) return true;
    return false;
  }

  function detectError() {
    const body = document.body.innerText || '';
    if (/something went wrong|try again later|error occurred/i.test(body)) return true;
    if (document.querySelector('[data-ved] [data-error]')) return true;
    return false;
  }

  // ─── Wait for Results ─────────────────────────────────────────────────────

  function waitForResults(timeoutMs = 30000) {
    return new Promise((resolve) => {
      if (hasResults()) return resolve(true);

      const observer = new MutationObserver(() => {
        if (hasResults()) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(true);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      const timer = setTimeout(() => {
        observer.disconnect();
        resolve(false); // Resolve anyway — scrape whatever is there
      }, timeoutMs);
    });
  }

  // Matches NT$8,529 / $8,529 / TWD 8,529 / 8,529 TWD
  const PRICE_RE = /(?:NT\$|TWD\s*|\$)\s*[\d,]{3,}|[\d,]{3,}\s*TWD/;

  function hasResults() {
    // Strategy 1: known DOM selectors
    for (const sel of FLIGHT_ROW_SELECTORS) {
      const nodes = Array.from(document.querySelectorAll(sel)).filter(el => {
        const t = el.textContent;
        return PRICE_RE.test(t) && /\d{1,2}:\d{2}/.test(t);
      });
      if (nodes.length >= 2) return true;
    }
    // Strategy 2: text heuristic
    const count = Array.from(document.querySelectorAll('*')).filter((el) => {
      const t = el.textContent;
      return PRICE_RE.test(t) && /\d{1,2}:\d{2}/.test(t) && t.length < 6000 && t.length > 30;
    }).length;
    return count >= 2;
  }

  /**
   * Find flight card containers without relying on obfuscated class names.
   * Strategy 1: use known DOM selectors; Strategy 2: text heuristic.
   */
  function findFlightCards() {
    // Strategy 1: try known selectors, filter to those with price + time
    for (const sel of FLIGHT_ROW_SELECTORS) {
      const nodes = Array.from(document.querySelectorAll(sel)).filter(el => {
        const t = el.textContent;
        return PRICE_RE.test(t) && /\d{1,2}:\d{2}/.test(t);
      });
      if (nodes.length >= 2) return nodes;
    }

    // Strategy 2: text heuristic — find smallest elements containing price + time
    const candidates = Array.from(document.querySelectorAll('*')).filter((el) => {
      const t = el.textContent;
      return PRICE_RE.test(t) && /\d{1,2}:\d{2}/.test(t) && t.length < 6000 && t.length > 30;
    });

    candidates.sort((a, b) => a.textContent.length - b.textContent.length);

    return candidates.filter(
      (card) => !candidates.some((other) => other !== card && card.contains(other))
    );
  }

  // ─── Scrape ───────────────────────────────────────────────────────────────

  function scrape() {
    if (detectCaptcha()) {
      return { status: 'captcha', flights: [], url: location.href, scraped_at: new Date().toISOString() };
    }
    if (detectError()) {
      return { status: 'error', flights: [], url: location.href, scraped_at: new Date().toISOString() };
    }

    const cards = findFlightCards();

    if (cards.length === 0) {
      // Debug: sample page text to diagnose price format
      const bodyText = document.body.innerText || '';
      const priceHints = (bodyText.match(/[\$NT元TWD¥€£][^\n]{0,20}/g) || []).slice(0, 10);
      const timeHints  = (bodyText.match(/\d{1,2}:\d{2}[^\n]{0,30}/g) || []).slice(0, 5);
      return {
        status: 'no_results', flights: [], url: location.href,
        scraped_at: new Date().toISOString(),
        debug: { priceHints, timeHints, bodyLength: bodyText.length }
      };
    }

    const seen = new Set();
    const flights = [];
    for (const card of cards) {
      try {
        const flight = extractFlight(card);
        if (!flight || !flight.price) continue;
        const key = `${flight.price}|${flight.departure_time}|${flight.arrival_time}`;
        if (seen.has(key)) continue;
        seen.add(key);
        flights.push(flight);
        if (flights.length >= 20) break;
      } catch { /* skip malformed card */ }
    }

    return {
      status: flights.length > 0 ? 'ok' : 'no_results',
      flights,
      count: flights.length,
      url: location.href,
      scraped_at: new Date().toISOString()
    };
  }

  function extractFlight(card) {
    const text = card.textContent;

    // Price
    let price = null;
    const priceEl = Array.from(card.querySelectorAll('*')).find(
      (el) => el.childElementCount === 0 && /^(?:NT\$|TWD\s*|\$)\s*[\d,]{3,}$|^[\d,]{3,}\s*TWD$/.test(el.textContent.trim())
    );
    if (priceEl) {
      price = priceEl.textContent.trim();
    } else {
      const m = text.match(/(?:NT\$|TWD\s*|USD\s*|\$)\s*[\d,]{3,}|[\d,]{3,}\s*TWD/);
      if (m) price = m[0].trim();
    }

    // Times (take first two HH:MM occurrences)
    const timePattern = /\b\d{1,2}:\d{2}\b/g;
    const times = (text.match(timePattern) || []).slice(0, 2);
    const departure_time = times[0] || null;
    const arrival_time  = times[1] || null;

    // Duration — supports Chinese (3 小時 30 分 / 3 小時) and English (3h 30m / 3 hr 30 min)
    const durationMatch = text.match(/\d+\s*小時(?:\s*\d+\s*分)?|\d+\s*hr?\s*\d*\s*min?|\d+\s*h\s*\d*\s*m/i);
    const duration = durationMatch ? durationMatch[0].trim() : null;

    // Stops — 直達 = nonstop; X 站/stop
    let stops = null;
    if (/直達/.test(text) || /nonstop/i.test(text)) {
      stops = 0;
    } else {
      const stopMatch = text.match(/(\d+)\s*(?:站|stop)/i);
      if (stopMatch) stops = parseInt(stopMatch[1], 10);
    }

    // Airline — extract text between first time block and duration/airport info
    // Pattern: times block → airline name → duration
    let airline = null;
    // Try to find a text node that looks like an airline name (CJK or Latin words, no digits)
    const airlineMatch = text.match(/(?:\d{1,2}:\d{2}[^$\d]{0,30}?)([^\d$–\-\n]{2,30}?)(?:\d+\s*小時|\d+\s*h)/);
    if (airlineMatch) {
      const candidate = airlineMatch[1].trim().replace(/[^\u4e00-\u9fff\u3040-\u30ffa-zA-Z\s]/g, '').trim();
      if (candidate.length >= 2) airline = candidate;
    }
    // Fallback: scan leaf text nodes for known airline-like strings (CJK 2-8 chars ending in 航空/航線/Airways etc.)
    if (!airline) {
      for (const el of card.querySelectorAll('*')) {
        if (el.childElementCount !== 0) continue;
        const t = el.textContent.trim();
        if (/(?:航空|航線|Airways|Airlines|Air\s|Express)/i.test(t) && t.length <= 20) {
          airline = t;
          break;
        }
      }
    }

    // CO2 — supports Chinese (183 公斤 CO2e) and English (183 kg CO2)
    const co2Match = text.match(/(\d+)\s*(?:公斤|kg)\s*CO2/i);
    const co2 = co2Match ? co2Match[0] : null;

    // Route — airport code pair
    const routeMatch = text.match(/([A-Z]{3})\s*[–\-→]\s*([A-Z]{3})/);
    const route = routeMatch ? routeMatch[0] : null;

    return { airline, departure_time, arrival_time, duration, stops, price, co2, route };
  }

  // ─── Form Automation (Search) ─────────────────────────────────────────────

  const nativeInputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

  // Type char-by-char: nativeInputSetter + full keyboard event chain
  async function typeIntoGF(el, text) {
    el.click();
    await sleep(400);
    el.focus();
    await sleep(300);

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

    // Clear
    setter?.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(100);

    for (const char of text) {
      const charCode = char.toUpperCase().charCodeAt(0);
      el.dispatchEvent(new KeyboardEvent('keydown', { key: char, keyCode: charCode, which: charCode, bubbles: true }));
      setter?.call(el, el.value + char);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: char }));
      el.dispatchEvent(new KeyboardEvent('keyup',  { key: char, keyCode: charCode, which: charCode, bubbles: true }));
      await sleep(150);
    }
  }

  // Suggestions to skip — generic placeholders that aren't real airports
  const SKIP_SUGGESTION_RE = /任何地方|anywhere|explore destinations|不限目的地/i;

  async function selectFirstGFSuggestion(timeoutMs = 5000) {
    const start = Date.now();
    const selectors = [
      '[role="listbox"] [role="option"]',
      '[role="option"]',
      'li[data-value]',
    ];
    while (Date.now() - start < timeoutMs) {
      for (const sel of selectors) {
        const visible = Array.from(document.querySelectorAll(sel))
          .filter(el => el.offsetParent !== null && !SKIP_SUGGESTION_RE.test(el.textContent));
        if (visible.length > 0) {
          visible[0].click();
          await sleep(300);
          return true;
        }
      }
      await sleep(150);
    }
    // Fallback: ArrowDown + Enter
    const active = document.activeElement;
    if (active) {
      active.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await sleep(200);
      active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(300);
    }
    return false;
  }

  function findGFInput(patterns) {
    for (const p of patterns) {
      const el = document.querySelector(`input[aria-label*="${p}"], [aria-label*="${p}"] input`);
      if (el) return el;
    }
    return null;
  }

  function toGFDate(isoDate) {
    const [, m, d] = isoDate.split('-').map(Number);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[m - 1]} ${d}`;
  }

  // Click a specific date in the GF calendar using the full ISO date string
  async function clickCalendarDate(isoDate) {
    // Strategy 1: data-iso exact match
    let cell = document.querySelector(`[data-iso="${isoDate}"]`);
    if (cell?.offsetParent) { (cell.querySelector('span') || cell).click(); await sleep(500); return true; }

    // Strategy 2: aria-label containing the date string or "N日"
    const day = parseInt(isoDate.split('-')[2], 10);
    const month = parseInt(isoDate.split('-')[1], 10);
    const candidates = Array.from(document.querySelectorAll(
      '[role="gridcell"], [role="button"][data-iso], td[data-date], li[data-date]'
    ));
    for (const c of candidates) {
      const label = c.getAttribute('aria-label') || c.getAttribute('data-date') || '';
      const iso   = c.getAttribute('data-iso') || '';
      if ((iso === isoDate) ||
          (label.includes(isoDate)) ||
          (label.includes(`${month}月`) && label.includes(`${day}日`))) {
        if (c.offsetParent && !c.getAttribute('aria-disabled')) {
          (c.querySelector('span') || c).click();
          await sleep(500);
          return true;
        }
      }
    }

    // Strategy 3: find gridcell whose visible text is exactly the day number
    for (const c of Array.from(document.querySelectorAll('[role="gridcell"]'))) {
      if (c.textContent.trim() === String(day) && c.offsetParent && !c.getAttribute('aria-disabled')) {
        c.click();
        await sleep(500);
        return true;
      }
    }
    return false;
  }

  async function search(params) {
    const { origin, destination, departure_date, return_date } = params;
    const isRoundTrip = !!return_date;
    const steps = [];

    // Step 1: Origin — aria-label="從哪裡出發？"
    const originInput = findGFInput(['從哪裡出發', 'Where from', '出發地']) ||
      Array.from(document.querySelectorAll('input[aria-label][type="text"]'))
        .find(el => el.offsetParent !== null);
    if (!originInput) {
      return { status: 'error', error: 'Origin input not found', steps };
    }
    originInput.click();
    await sleep(400);
    await typeIntoGF(originInput, origin);
    await sleep(1800);
    const originOk = await selectFirstGFSuggestion(5000);
    steps.push({ step: 'fill_origin', ok: originOk });
    await sleep(800);

    // Step 2: Destination — aria-label="要去哪裡？"
    // After origin selection GF auto-focuses destination
    let destInput = null;
    const ae = document.activeElement;
    const aeLabel = ae?.getAttribute?.('aria-label') || '';
    if (ae && ae.tagName === 'INPUT' && !/從哪裡出發|where from/i.test(aeLabel)) {
      destInput = ae;
    }
    if (!destInput) destInput = findGFInput(['要去哪裡', 'Where to', '目的地']);
    if (!destInput) {
      const labelled = Array.from(document.querySelectorAll('input[aria-label][type="text"]'))
        .filter(el => el !== originInput && el.offsetParent !== null);
      destInput = labelled[0] || null;
    }
    if (!destInput) return { status: 'error', error: 'Destination not found', steps };

    if (destInput !== document.activeElement) destInput.click();
    await sleep(400);
    await typeIntoGF(destInput, destination);
    await sleep(1800);
    const destOk = await selectFirstGFSuggestion(5000);
    steps.push({ step: 'fill_dest', ok: destOk });
    await sleep(800);

    // Step 3: Departure date — aria-label="去程" → click to open calendar, then click exact ISO date
    const depInput = findGFInput(['去程', 'Departure', 'Start date']);
    if (depInput) { depInput.click(); await sleep(1200); }
    const depOk = await clickCalendarDate(departure_date);
    steps.push({ step: 'fill_dep_date', date: departure_date, ok: depOk });
    await sleep(600);

    // Step 4: Return date — calendar usually stays open after dep selection
    if (isRoundTrip && return_date) {
      const calStillOpen = !!document.querySelector('[role="gridcell"]');
      if (!calStillOpen) {
        const retInput = findGFInput(['回程', 'Return', 'End date']);
        if (retInput) { retInput.click(); await sleep(1000); }
      }
      const retOk = await clickCalendarDate(return_date);
      steps.push({ step: 'fill_ret_date', date: return_date, ok: retOk });
      await sleep(600);
    }

    // Step 5: Click "完成" to close calendar (GF shows this after both dates picked)
    await sleep(300);
    const doneBtn = Array.from(document.querySelectorAll('button')).find(
      btn => btn.offsetParent !== null && /^完成$|^Done$/i.test(btn.textContent.trim())
    );
    if (doneBtn) {
      steps.push({ step: 'close_calendar', text: doneBtn.textContent.trim() });
      doneBtn.click();
      await sleep(800);
    } else {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(500);
    }

    // Step 6: Wait for Google Flights to auto-navigate to the tfs= results URL
    // after the "完成" button closes the calendar.
    // GF submits automatically — do NOT click any extra button.
    const urlBefore = location.href;
    let autoNavigated = false;
    for (let i = 0; i < 40; i++) {   // up to 4 s
      await sleep(100);
      if (location.href !== urlBefore && location.href.includes('tfs=')) {
        autoNavigated = true;
        break;
      }
    }
    steps.push({ step: 'auto_navigate', autoNavigated, url: location.href });

    // If no auto-navigate, look for an explicit Search button
    if (!autoNavigated) {
      const SEARCH_BTN_RE = /^搜尋$|^Search$/i;
      const searchBtn =
        Array.from(document.querySelectorAll('button')).find(
          btn => btn.offsetParent !== null && SEARCH_BTN_RE.test(btn.textContent.trim())
        ) ||
        document.querySelector('button[aria-label*="搜尋"], button[aria-label*="Search"]');

      steps.push({ step: 'search_btn', found: !!searchBtn });
      if (searchBtn) {
        searchBtn.click();
        steps.push({ step: 'click_search', method: 'button' });
      } else {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        steps.push({ step: 'click_search', method: 'enter' });
      }
    }
    await sleep(2000);

    // Step 7: Wait for results — also wait an extra 3 s for SPA to settle
    await sleep(3000);
    const found = await waitForResults(45000);
    steps.push({ step: 'wait_results', found });

    const result = scrape();
    result.steps = steps;
    return result;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─── Message Listener ─────────────────────────────────────────────────────

  function messageListener(msg, _sender, sendResponse) {
    const { action, params } = msg;

    if (action === 'ping') {
      sendResponse({ ok: true });
      return true;
    }

    if (action === 'scrape') {
      waitForResults(15000).then(() => sendResponse(scrape()));
      return true; // async
    }

    if (action === 'search') {
      search(params)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ status: 'error', error: err.message }));
      return true; // async
    }

    return false;
  }

  window.__flightMcpGfListener = messageListener;
  chrome.runtime.onMessage.addListener(messageListener);

})();
