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
    '[role="listitem"][jsname="I67f9p"]',
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
    '[jsname="V867re"]',
    '.YMlIz',
    '.priceText',
    '.gws-flights-results__itinerary-price',
    'span[role="text"]'
  ];

  const AIRLINE_SELECTORS = [
    '.Ir0Voe .sSHqwe',
    '[jsname="K90p6"]',
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
    // Check for "No flights found" text
    if (/沒有找到航班|No flights found|未找到符合條件的航班/i.test(body) && body.length < 5000) return true;
    return false;
  }

  // ─── Wait for Results ─────────────────────────────────────────────────────

  /**
   * Wait for results with a stability check.
   * Ensures results have appeared AND haven't changed for 500ms.
   */
  function waitForResults(timeoutMs = 30000, stabilityMs = 500) {
    return new Promise((resolve) => {
      if (hasResults()) {
        let stabilityTimer = setTimeout(() => resolve(true), stabilityMs);
        const stabilityObserver = new MutationObserver(() => {
          clearTimeout(stabilityTimer);
          stabilityTimer = setTimeout(() => {
            stabilityObserver.disconnect();
            resolve(true);
          }, stabilityMs);
        });
        stabilityObserver.observe(document.body, { childList: true, subtree: true });
        return;
      }

      const observer = new MutationObserver(() => {
        if (hasResults()) {
          observer.disconnect();
          clearTimeout(timeoutTimer);
          // Wait for stability
          waitForResults(10000, stabilityMs).then(resolve);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      const timeoutTimer = setTimeout(() => {
        observer.disconnect();
        resolve(hasResults());
      }, timeoutMs);
    });
  }

  // Matches NT$8,529 / $8,529 / TWD 8,529 / 8,529 TWD
  const PRICE_RE = /(?:NT\$|TWD\s*|\$)\s*[\d,]{3,}|[\d,]{3,}\s*TWD/;
  const TIME_RE  = /\d{1,2}:\d{2}/;

  const SKIP_TAGS = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/i;

  // Collect rendered text including open Shadow DOM, skip script/style nodes
  function allText(root) {
    let t = '';
    const walker = document.createTreeWalker(
      root, NodeFilter.SHOW_TEXT,
      { acceptNode: n => SKIP_TAGS.test(n.parentElement?.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT }
    );
    let node;
    while ((node = walker.nextNode())) t += node.nodeValue + ' ';
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) t += allText(el.shadowRoot);
    }
    return t;
  }

  // Flatten querySelectorAll through shadow roots
  function queryAll(root, sel) {
    const results = Array.from(root.querySelectorAll(sel));
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) results.push(...queryAll(el.shadowRoot, sel));
    }
    return results;
  }

  function hasResults() {
    // Strategy 1: known DOM selectors (including shadow DOM)
    for (const sel of FLIGHT_ROW_SELECTORS) {
      const nodes = queryAll(document, sel).filter(el => {
        const t = el.textContent;
        return PRICE_RE.test(t) && TIME_RE.test(t);
      });
      if (nodes.length >= 2) return true;
    }
    // Strategy 2: full-text heuristic (shadow DOM included)
    const fullText = allText(document.body);
    return PRICE_RE.test(fullText) && TIME_RE.test(fullText) && fullText.length > 2000;
  }

  /**
   * Find flight card containers — searches normal DOM and open Shadow DOM.
   */
  function findFlightCards() {
    // Strategy 1: known selectors through shadow DOM
    for (const sel of FLIGHT_ROW_SELECTORS) {
      const nodes = queryAll(document, sel).filter(el => {
        const t = el.textContent;
        return PRICE_RE.test(t) && TIME_RE.test(t);
      });
      if (nodes.length >= 2) return nodes;
    }

    // Strategy 2: heuristic over all elements (shadow DOM included)
    const allEls = queryAll(document, '*');
    const candidates = allEls.filter(el => {
      const t = el.textContent;
      return PRICE_RE.test(t) && TIME_RE.test(t) && t.length < 6000 && t.length > 30;
    });

    candidates.sort((a, b) => a.textContent.length - b.textContent.length);
    return candidates.filter(
      card => !candidates.some(other => other !== card && card.contains(other))
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
      const bodyText  = document.body.innerText || '';
      const fullText  = allText(document.body);
      const priceHints = (fullText.match(/[\$NT元TWD¥€£][^\n]{0,20}/g) || []).slice(0, 10);
      const timeHints  = (fullText.match(/\d{1,2}:\d{2}[^\n]{0,30}/g) || []).slice(0, 5);
      return {
        status: 'no_results', flights: [], url: location.href,
        scraped_at: new Date().toISOString(),
        debug: {
          priceHints, timeHints,
          innerTextLen: bodyText.length,
          fullTextLen:  fullText.length,
          htmlLen:      document.body.innerHTML.length,
        }
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

  // Type text using execCommand — Angular / Google Flights picks this up correctly.
  async function typeIntoGF(el, text) {
    el.click();
    await sleep(400);
    el.focus();
    await sleep(300);

    // Select-all + delete clears both native value and Angular's model
    document.execCommand('selectAll', false);
    await sleep(100);
    document.execCommand('delete', false);
    await sleep(200);

    // insertText fires the correct InputEvent chain that Angular's autocomplete listens to
    document.execCommand('insertText', false, text);
    await sleep(100);
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
    const [year, month, day] = isoDate.split('-').map(Number);
    const dayStr = String(day);
    const monthStr = String(month);

    const candidates = Array.from(document.querySelectorAll(
      '[role="gridcell"], [role="button"][data-iso], td[data-date], li[data-date]'
    ));

    for (const c of candidates) {
      const label = (c.getAttribute('aria-label') || c.getAttribute('data-date') || '').toLowerCase();
      const iso   = c.getAttribute('data-iso') || '';

      if (iso === isoDate) {
        if (c.offsetParent && !c.getAttribute('aria-disabled')) {
          (c.querySelector('span') || c).click();
          await sleep(500);
          return true;
        }
      }

      // Check for various language formats: "April 5, 2026", "2026年4月5日", "4月5日"
      const hasMonth = label.includes(monthStr + '月') || label.includes(monthStr + '/') ||
                       /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(label);
      const hasDay = label.includes(dayStr + '日') || label.includes(' ' + dayStr + ',') ||
                     label.endsWith(' ' + dayStr) || label.includes('/' + dayStr + '/');

      if (hasMonth && hasDay) {
        const dayMatch = label.match(/\d+/);
        if (dayMatch && dayMatch[0] === dayStr) {
          if (c.offsetParent && !c.getAttribute('aria-disabled')) {
            c.click();
            await sleep(500);
            return true;
          }
        }
      }
    }

    // Strategy 3: find gridcell whose visible text is exactly the day number
    for (const c of Array.from(document.querySelectorAll('[role="gridcell"]'))) {
      if (c.textContent.trim() === dayStr && c.offsetParent && !c.getAttribute('aria-disabled')) {
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
    const originSuggestions = Array.from(document.querySelectorAll('[role="option"]'))
      .filter(el => el.offsetParent !== null)
      .map(el => el.textContent.trim().slice(0, 40));
    const originOk = await selectFirstGFSuggestion(5000);
    steps.push({ step: 'fill_origin', ok: originOk, inputValue: originInput.value, suggestions: originSuggestions });
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

    // Clear any pre-existing destination chip (GF may remember last search)
    let destContainer = destInput.parentElement;
    for (let n = 0; n < 6; n++) {
      if (!destContainer) break;
      const removeBtn = destContainer.querySelector(
        '[aria-label*="移除"], [aria-label*="Remove"], [aria-label*="Clear"], button[jsname="ZKbKQ"]'
      );
      if (removeBtn && removeBtn.offsetParent) {
        removeBtn.click();
        await sleep(600);
        break;
      }
      destContainer = destContainer.parentElement;
    }

    if (destInput !== document.activeElement) destInput.click();
    await sleep(400);
    await typeIntoGF(destInput, destination);
    await sleep(1800);

    // Debug: log visible suggestions before picking
    const suggestionTexts = Array.from(document.querySelectorAll('[role="option"]'))
      .filter(el => el.offsetParent !== null)
      .map(el => el.textContent.trim().slice(0, 40));
    const destOk = await selectFirstGFSuggestion(5000);
    steps.push({ step: 'fill_dest', ok: destOk, inputValue: destInput.value, suggestions: suggestionTexts });
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

    // Step 7: Wait for page to settle
    await sleep(2500);

    // Step 8: Ensure cabin matches (Safety net if Protobuf URL failed)
    // Run this BEFORE the final results wait to ensure we scrape the right class
    if (params.cabin && params.cabin !== 'economy') {
      console.log(`[gf] Ensuring cabin: ${params.cabin}`);
      const cabinOk = await ensureCabin(params.cabin);
      steps.push({ step: 'ensure_cabin', cabin: params.cabin, ok: cabinOk });
      if (cabinOk) {
        await sleep(1500);
        await waitForResults(30000);
      }
    }

    const found = await waitForResults(30000);
    steps.push({ step: 'wait_results', found });

    const result = scrape();
    result.steps = steps;
    return result;
  }

  /**
   * Safety net: check if currently selected cabin matches requested cabin.
   * If not, click and select the correct one.
   */
  async function ensureCabin(targetCabin) {
    const cabinMap = {
      economy: ['經濟艙', 'Economy', 'Coach'],
      premium_economy: ['豪華經濟艙', 'Premium Economy'],
      business: ['商務艙', 'Business'],
      first: ['頭等艙', 'First']
    };
    const targets = cabinMap[targetCabin.toLowerCase()] || [targetCabin];
    const allCabinNames = Object.values(cabinMap).flat();

    console.log(`[gf] Searching for cabin button to match: ${targets.join('/')}`);

    // Strategy 1: Find all elements that look like a dropdown/menu
    const potentialButtons = Array.from(document.querySelectorAll('button, [role="button"], [aria-haspopup="true"], [aria-haspopup="listbox"], [jsname="VfPpkd-LgbsSe"]'));
    
    let cabinBtn = potentialButtons.find(el => {
      if (el.offsetParent === null) return false;
      const text = el.innerText.trim();
      // Look for a button that strictly contains a cabin name
      return allCabinNames.some(name => text === name || text.includes(name)) && 
             (text.length < 20); // Avoid large containers that happen to contain the word
    });

    // Strategy 2: Find by proximity to passenger count (the button with "1 位" or "2 passengers")
    if (!cabinBtn) {
      const paxBtn = potentialButtons.find(el => 
        el.offsetParent !== null && /(\d+)\s*(?:位|passenger|大人|adult)/i.test(el.innerText)
      );
      if (paxBtn) {
        // Look at siblings or parent's siblings
        let next = paxBtn.nextElementSibling;
        if (!next) next = paxBtn.parentElement.nextElementSibling;
        if (next && allCabinNames.some(name => next.innerText.includes(name))) {
          cabinBtn = next;
        }
      }
    }

    if (!cabinBtn) {
      console.log('[gf] Could not locate cabin button');
      return false;
    }

    const currentText = cabinBtn.innerText.trim();
    console.log(`[gf] Found cabin button with text: "${currentText}"`);
    
    if (targets.some(t => currentText.includes(t))) {
      console.log('[gf] Cabin is already correct');
      return true;
    }

    // Try multiple click strategies
    console.log('[gf] Attempting to open cabin menu...');
    cabinBtn.click();
    // Also dispatch mousedown as a backup
    cabinBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await sleep(1200);

    // Find the option in the listbox
    const options = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], .VfPpkd-StrEme-OWXEXe-mYmUPf'));
    console.log(`[gf] Found ${options.length} potential options in menu`);
    
    const targetOpt = options.find(o => 
      targets.some(t => o.innerText.trim().includes(t))
    );

    if (targetOpt) {
      console.log(`[gf] Selecting: ${targetOpt.innerText.trim()}`);
      targetOpt.click();
      await sleep(2000); // Wait for results to update
      return true;
    }

    console.log('[gf] Could not find the target cabin option in the menu');
    document.body.click(); // Close menu if stuck
    return false;
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
      (async () => {
        // Scroll to trigger lazy-loaded flight list, then wait for results
        window.scrollBy(0, 400);
        await sleep(800);
        window.scrollBy(0, 400);
        await sleep(800);
        window.scrollTo(0, 0);
        await sleep(500);
        await waitForResults(15000);
        const result = scrape();
        // If still no results, add raw HTML hints for diagnosis
        if (result.status === 'no_results') {
          result.debug = result.debug || {};
          result.debug.htmlLen = document.documentElement.innerHTML.length;

          // Look for embedded JSON flight data in inline script tags
          const scripts = Array.from(document.querySelectorAll('script:not([src])'));
          const flightScripts = scripts.filter(s =>
            s.textContent.length > 5000 &&
            /\d{1,2}:\d{2}/.test(s.textContent) &&
            /[A-Z]{3}/.test(s.textContent)
          );
          if (flightScripts.length > 0) {
            // Try to extract times and prices from the script data
            const scriptText = flightScripts.map(s => s.textContent).join(' ');
            result.debug.scriptTimeHints  = (scriptText.match(/(?:0[6-9]|1\d|2[0-3]):[0-5]\d/g) || []).slice(0, 8);
            result.debug.scriptPriceHints = (scriptText.match(/(?:NT\$|TWD)[\d,]{3,}/g) || []).slice(0, 5);
            result.debug.flightScriptCount = flightScripts.length;
          }
        }
        sendResponse(result);
      })();
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
