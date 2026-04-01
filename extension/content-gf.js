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
      if (hasResults()) return resolve();

      const observer = new MutationObserver(() => {
        if (hasResults()) {
          observer.disconnect();
          clearTimeout(timer);
          resolve();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      const timer = setTimeout(() => {
        observer.disconnect();
        resolve(); // Resolve anyway — scrape whatever is there
      }, timeoutMs);
    });
  }

  function hasResults() {
    // Look for elements that contain both a price and a time (actual flight cards)
    const count = Array.from(document.querySelectorAll('*')).filter((el) => {
      const t = el.textContent;
      return /\$[\d,]+/.test(t) && /\d{1,2}:\d{2}/.test(t) && t.length < 3000 && t.length > 30;
    }).length;
    return count >= 2;
  }

  /**
   * Find flight card containers without relying on obfuscated class names.
   * Strategy: find all elements whose text contains both a price and a time,
   * take the smallest ones, then deduplicate by keeping only innermost nodes.
   */
  function findFlightCards() {
    const candidates = Array.from(document.querySelectorAll('*')).filter((el) => {
      const t = el.textContent;
      return /\$[\d,]+/.test(t) && /\d{1,2}:\d{2}/.test(t) && t.length < 3000 && t.length > 30;
    });

    // Sort by text length ascending — smallest containing elements first
    candidates.sort((a, b) => a.textContent.length - b.textContent.length);

    // Keep only innermost (remove ancestors of other candidates)
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
      return { status: 'no_results', flights: [], url: location.href, scraped_at: new Date().toISOString() };
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
      (el) => el.childElementCount === 0 && /^\$[\d,]+$/.test(el.textContent.trim())
    );
    if (priceEl) {
      price = priceEl.textContent.trim();
    } else {
      const m = text.match(/(?:NT\$|TWD\s*|USD\s*|\$)\s*([\d,]+)/);
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

  // ─── Message Listener ─────────────────────────────────────────────────────

  function messageListener(msg, _sender, sendResponse) {
    const { action } = msg;

    if (action === 'ping') {
      sendResponse({ ok: true });
      return true;
    }

    if (action === 'scrape') {
      waitForResults(5000).then(() => sendResponse(scrape()));
      return true; // async
    }

    return false;
  }

  window.__flightMcpGfListener = messageListener;
  chrome.runtime.onMessage.addListener(messageListener);

})();
