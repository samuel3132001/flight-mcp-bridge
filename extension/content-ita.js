/**
 * Flight MCP Bridge — ITA Matrix Content Script
 *
 * Handles:
 *   action: "search"  — fill & submit ITA Matrix search form
 *   action: "scrape"  — scrape current results
 *   action: "ping"    — liveness check
 *
 * ITA Matrix is a GWT SPA — URLs don't encode search params.
 * All interaction must go through DOM manipulation with simulated keyboard events.
 */

(function () {
  'use strict';

  if (window.__flightMcpItaListener) {
    chrome.runtime.onMessage.removeListener(window.__flightMcpItaListener);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function qs(sel, root = document) { return root.querySelector(sel); }
  function qsAll(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

  /**
   * Find an input by its associated label text (case-insensitive substring).
   */
  function findInputByLabel(labelText) {
    const labels = qsAll('label');
    for (const label of labels) {
      if (label.textContent.toLowerCase().includes(labelText.toLowerCase())) {
        if (label.htmlFor) {
          const el = document.getElementById(label.htmlFor);
          if (el) return el;
        }
        const inp = label.querySelector('input');
        if (inp) return inp;
      }
    }
    // aria-label fallback
    const inputs = qsAll('input[aria-label]');
    for (const inp of inputs) {
      if (inp.getAttribute('aria-label').toLowerCase().includes(labelText.toLowerCase())) return inp;
    }
    return null;
  }

  const nativeInputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

  /**
   * Type into an Angular Material input char-by-char.
   * Uses the native value setter + input + keyup events.
   * Angular Material's MatAutocompleteTrigger listens to both.
   */
  async function typeInto(el, text) {
    el.focus();
    await sleep(200);

    // Clear
    nativeInputSetter?.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(80);

    for (const char of text) {
      const newVal = el.value + char;
      nativeInputSetter?.call(el, newVal);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: char }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
      await sleep(80);
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Wait for an autocomplete suggestion dropdown and click the first item.
   */
  async function selectFirstSuggestion(timeoutMs = 5000) {
    const start = Date.now();
    const DROPDOWN_SELECTORS = [
      '.mat-option',                        // Angular Material
      '[role="listbox"] [role="option"]',
      '[role="option"]',
      '.mat-autocomplete-panel .mat-option',
      '.gwt-SuggestBoxPopup .item',
      '.gwt-MenuItem',
      '[class*="suggest"] li',
    ];

    while (Date.now() - start < timeoutMs) {
      for (const sel of DROPDOWN_SELECTORS) {
        const items = qsAll(sel);
        if (items.length > 0) {
          items[0].click();
          await sleep(200);
          return true;
        }
      }
      await sleep(150);
    }
    return false;
  }

  /**
   * Wait until results appear (price rows visible).
   */
  async function waitForResults(timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (hasResults()) return true;
      await sleep(500);
    }
    return false;
  }

  function hasResults() {
    const RESULT_SELECTORS = [
      '[role="grid"] tr',
      'table[class*="results"] tr',
      'table tr td[class*="price"]',
      '[class*="itinerary"]',
    ];
    for (const s of RESULT_SELECTORS) {
      if (qsAll(s).length >= 2) return true;
    }
    const pricePattern = /(?:USD|TWD|NT\$|\$)\s*[\d,]{2,}/;
    return pricePattern.test(document.body.innerText);
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  /**
   * Convert YYYY-MM-DD to MM/DD/YYYY (ITA Matrix date format)
   */
  function toITADate(isoDate) {
    const [y, m, d] = isoDate.split('-');
    return `${m}/${d}/${y}`;
  }

  async function search(params) {
    const { origin, destination, departure_date, return_date, passengers = 1 } = params;
    const isRoundTrip = !!return_date;
    const steps = [];

    // Step 1: Trip type — MDC Tab component (.mdc-tab__content > span)
    // Do this FIRST so Angular re-renders the correct form inputs before we query them
    let tripTypeSet = false;
    const targetText = isRoundTrip ? 'Round Trip' : 'One Way';
    const tripSpans = Array.from(document.querySelectorAll('.mdc-tab__content span, [role="tab"] span, mat-tab span'));
    for (const span of tripSpans) {
      if (span.textContent.trim() === targetText) {
        const tabBtn = span.closest('button, [role="tab"]') || span.parentElement?.parentElement;
        if (tabBtn) {
          tabBtn.click();
          await sleep(800);
          // Verify via aria-selected on the button
          const isActive = tabBtn.getAttribute('aria-selected') === 'true'
            || tabBtn.classList.contains('mat-mdc-tab-active')
            || tabBtn.classList.contains('mat-tab-label-active');
          tripTypeSet = true;
          steps.push({ step: 'trip_type', set: true, verified: isActive, type: isRoundTrip ? 'round' : 'oneway' });
          break;
        }
      }
    }
    if (!tripTypeSet) {
      steps.push({ step: 'trip_type', set: false, type: isRoundTrip ? 'round' : 'oneway',
                   tabsFound: tripSpans.map(s => s.textContent.trim()) });
    }

    // Wait for Angular to settle after trip type change, then re-query inputs
    await sleep(1000);

    // Step 2: Find form inputs (after trip type change so form is in correct state)
    const allInputs = qsAll('input');
    const airportInputs = Array.from(allInputs).filter(el => el.placeholder === 'Add airport');
    const originInput = airportInputs[0];
    const destInput   = airportInputs[1];

    const textInputs = Array.from(allInputs).filter(el => el.type === 'text');
    const dateInput = Array.from(allInputs).find(el => el.placeholder === 'Start date')
      || textInputs.find(el => el !== originInput && el !== destInput && !el.getAttribute('aria-label'));
    const retInput = Array.from(allInputs).find(el => el.placeholder === 'End date')
      || textInputs.filter(el => el !== originInput && el !== destInput && !el.getAttribute('aria-label'))[1];

    steps.push({ step: 'inputs', originFound: !!originInput, destFound: !!destInput, dateFound: !!dateInput,
                 originPlaceholder: originInput?.placeholder, datePlaceholder: dateInput?.placeholder });

    if (!originInput || !destInput || !dateInput) {
      return { status: 'error', error: 'ITA Matrix form inputs not found', steps };
    }

    // Step 3: Fill origin
    await sleep(500);
    await typeInto(originInput, origin);
    await sleep(1500);
    let originOptCount = document.querySelectorAll('.mat-option, [role="option"]').length;
    let originSuggestion = await selectFirstSuggestion(4000);
    if (!originSuggestion) {
      // Retry once
      await typeInto(originInput, origin);
      await sleep(1500);
      originOptCount = document.querySelectorAll('.mat-option, [role="option"]').length;
      originSuggestion = await selectFirstSuggestion(4000);
    }
    steps.push({ step: 'fill_origin', valueAfter: originInput.value, optionsVisible: originOptCount, suggestion: originSuggestion });

    // Step 4: Fill destination
    await typeInto(destInput, destination);
    await sleep(1500);
    const destOptCount = document.querySelectorAll('.mat-option, [role="option"]').length;
    const destSuggestion = await selectFirstSuggestion(4000);
    steps.push({ step: 'fill_dest', valueAfter: destInput.value, optionsVisible: destOptCount, suggestion: destSuggestion });

    // Step 5: Fill departure date (ITA uses MM/DD/YYYY)
    const itaDate = toITADate(departure_date);
    await typeInto(dateInput, itaDate);
    await sleep(500);
    dateInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    await sleep(300);
    steps.push({ step: 'fill_date', value: itaDate, valueAfter: dateInput.value });

    // Step 6: Return date (round trip only)
    if (isRoundTrip && return_date && retInput) {
      const itaRetDate = toITADate(return_date);
      await typeInto(retInput, itaRetDate);
      await sleep(500);
      retInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      await sleep(200);
      steps.push({ step: 'fill_return_date', value: itaRetDate });
    }

    // Step 7: Click Search — find the Search button and check if it's enabled
    let searchBtn = null;
    for (const btn of qsAll('button')) {
      const txt = btn.textContent.trim();
      if (/\bSearch\b/.test(txt) && btn.getAttribute('aria-label') !== 'toggle light/dark theme') {
        searchBtn = btn;
        break;
      }
    }

    const btnDisabled = searchBtn ? (searchBtn.disabled || searchBtn.getAttribute('aria-disabled') === 'true') : null;
    steps.push({ step: 'search_btn', found: !!searchBtn, disabled: btnDisabled });

    if (!searchBtn) {
      return { status: 'error', error: 'Could not find Search button', steps };
    }

    searchBtn.click();

    // Step 8: Wait for results (budget: ~50s to stay within 82s total)
    await sleep(2000);
    const found = await waitForResults(48000);
    steps.push({ step: 'wait_results', found });

    const result = scrape(found);
    result.steps = steps;
    return result;
  }

  // ─── Scrape ───────────────────────────────────────────────────────────────

  function scrape(hasData = true) {
    if (!hasData && !hasResults()) {
      return { status: 'no_results', fares: [], url: location.href, scraped_at: new Date().toISOString() };
    }

    const fares = [];

    // Strategy 1: Grid/table rows
    const gridRows = qsAll('[role="grid"] tr, [role="row"], table tr');
    for (const row of gridRows) {
      const fare = extractFare(row);
      if (fare && fare.price) fares.push(fare);
    }

    // Strategy 2: Itinerary containers
    if (fares.length === 0) {
      const containers = qsAll('[class*="itinerary"], [class*="result"], [class*="fare"]');
      for (const c of containers) {
        const fare = extractFare(c);
        if (fare && fare.price) fares.push(fare);
      }
    }

    // Strategy 3: Text pattern scan as last resort
    if (fares.length === 0) {
      const pricePattern = /(?:USD|TWD|NT\$|\$)\s*([\d,]+)/g;
      const bodyText = document.body.innerText;
      let m;
      const prices = [];
      while ((m = pricePattern.exec(bodyText)) !== null) {
        prices.push(m[0].trim());
      }
      if (prices.length > 0) {
        return {
          status: 'ok',
          fares: prices.map((p) => ({ price: p, note: 'text-pattern-scan' })),
          url: location.href,
          scraped_at: new Date().toISOString(),
          _warning: 'Structured scraping failed; prices extracted via text pattern'
        };
      }
    }

    return {
      status: fares.length > 0 ? 'ok' : 'no_results',
      fares,
      count: fares.length,
      url: location.href,
      scraped_at: new Date().toISOString()
    };
  }

  function extractFare(row) {
    const text = row.textContent;
    if (!text.trim()) return null;

    const priceMatch = text.match(/(?:USD|TWD|NT\$|\$)\s*([\d,]+)/);
    const price = priceMatch ? priceMatch[0].trim() : null;

    const routeMatch = text.match(/([A-Z]{3})\s*[–\-→]\s*([A-Z]{3})/);
    const routing = routeMatch ? routeMatch[0] : null;

    const fareClassMatch = text.match(/\b([A-Z]\d?)\s+(?:class|fare)\b/i);
    const fare_class = fareClassMatch ? fareClassMatch[1] : null;

    const airlineEl = qs('[class*="airline"], [class*="carrier"]', row);
    const airline = airlineEl ? airlineEl.textContent.trim() : null;

    const durationMatch = text.match(/(\d+)h\s*(\d+)?m|(\d+)\s*hr?\s*(\d+)?\s*min?/i);
    const duration = durationMatch ? durationMatch[0].trim() : null;

    const stopsMatch = text.match(/nonstop|(\d+)\s*stop/i);
    let stops = null;
    if (stopsMatch) {
      stops = stopsMatch[0].toLowerCase().includes('nonstop') ? 0 : parseInt(stopsMatch[1], 10);
    }

    const timePattern = /\b\d{1,2}:\d{2}(?:\s*[AP]M)?\b/gi;
    const times = (text.match(timePattern) || []).slice(0, 2);

    return {
      price,
      routing,
      fare_class,
      airline,
      duration,
      stops,
      departure_time: times[0] || null,
      arrival_time: times[1] || null
    };
  }

  // ─── Message Listener ─────────────────────────────────────────────────────

  function messageListener(msg, _sender, sendResponse) {
    const { action, params } = msg;

    if (action === 'ping') {
      sendResponse({ ok: true });
      return true;
    }

    if (action === 'scrape') {
      sendResponse(scrape(hasResults()));
      return true;
    }

    if (action === 'search') {
      search(params)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ status: 'error', error: err.message }));
      return true;
    }

    return false;
  }

  window.__flightMcpItaListener = messageListener;
  chrome.runtime.onMessage.addListener(messageListener);

})();
