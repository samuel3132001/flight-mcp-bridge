# Flight Search Agent — Workflow Guide

This guide describes how to use the `flights` MCP server to find optimal airfares.
The server bridges to a real Brave Browser session running Google Flights and ITA Matrix.

## Prerequisites

1. Brave Browser must be open with the **Flight MCP Bridge** extension enabled (badge shows **ON**).
2. The bridge process must be running:
   - Local: it is auto-spawned by Claude Code.
   - Remote: confirm `/health` on the tailnet host returns `"extension_connected": true`.

---

## Two-Phase Search Strategy

### Phase 1 — Discovery via ITA Matrix

ITA Matrix is a fare construction engine used by travel agents. It surfaces:
- All fare classes (Y, B, M, K, Q, …) including deeply discounted buckets
- Hidden-city fares (fly through your destination, deplane early)
- Open-jaw routes (fly into one city, return from another)
- Multi-city combinations invisible to consumer sites

**Steps:**

```
1. Call search_ita(origin, destination, departure_date, [return_date], [passengers])
   → ITA Matrix opens, form is filled, search is submitted automatically.
   → Wait: ITA is slow. Allow 30–60 seconds for results.

2. Call scrape_ita_results()
   → Returns: { status, fares: [{price, routing, fare_class, airline, ...}] }
```

**Notes:**
- If `status == "no_results"`, the route may not be served. Try alternate airports or dates.
- ITA sometimes requires a CAPTCHA before showing results — it will appear in the browser. Instruct the user to solve it manually, then call `scrape_ita_results()` again.
- Fare classes: Y/B/M = full-fare economy; H/K/Q/T/X/V/W = discounted buckets; Z = business.

---

### Phase 2 — Validation via Google Flights

Google Flights shows real-time bookable fares and links to purchase.
Use it to verify that ITA's theoretical fares are actually purchasable.

**Steps:**

```
3. Call search_flights(origin, destination, departure_date, [return_date], [passengers])
   → Google Flights opens with matching search.
   → Wait ~10 seconds for results to render.

4. Call scrape_results()
   → Returns: { status, flights: [{airline, departure_time, arrival_time, duration, stops, price, route}] }
```

---

## Reporting Results

Compare and present both data sets in a table:

| Metric | ITA Matrix | Google Flights |
|--------|-----------|----------------|
| Lowest fare | $XXX (fare class K) | $XXX |
| Routing | TPE → NRT via XXX | Direct |
| Airline | XX | XX |
| Fare class | K | — |
| Bookable? | Theoretical | ✓ Link available |

Always include:
- Price in the user's preferred currency
- Number of stops
- Total travel time
- Booking action (direct link if available from Google Flights)

---

## Edge Cases & Gotchas

| Situation | Action |
|-----------|--------|
| ITA CAPTCHA | Ask user to solve it in Brave, then call `scrape_ita_results()` |
| ITA `status: "no_results"` | Try ±1–3 days; try adjacent airports (e.g., TPE ↔ TSA, NRT ↔ HND) |
| Google Flights `status: "captcha"` | Ask user to open Brave and solve; retry `scrape_results()` |
| Fare on foreign airline's site | Search from that airline's home country URL (price may differ) |
| Hidden city | Confirm user is aware: must not check bags; return leg invalidates |
| Open jaw | ITA will show it; Google Flights may not — book each leg separately |

---

## Tool Reference

| Tool | Purpose | Avg. time |
|------|---------|-----------|
| `search_ita` | Submit search to ITA Matrix | 5–10s (page load + form fill) |
| `scrape_ita_results` | Read ITA results | 1–2s |
| `search_flights` | Submit search to Google Flights | 3–5s |
| `scrape_results` | Read Google Flights results | 1–2s |

All tools timeout at **90 seconds**. ITA Matrix results can take up to 60 seconds to load after submission — if `scrape_ita_results` returns `no_results` but ITA is still loading, wait and retry.

---

## Example Session

```
User: Find cheapest round-trip TPE → JFK in early April, 1 adult

Agent:
1. search_ita(origin="TPE", destination="JFK", departure_date="2025-04-05", return_date="2025-04-15")
   → ITA loads, form filled, searching…

2. (wait ~40s)

3. scrape_ita_results()
   → fares: [{price: "TWD 28,900", fare_class: "K", routing: "TPE→NRT→JFK", airline: "ANA"}, ...]

4. search_flights(origin="TPE", destination="JFK", departure_date="2025-04-05", return_date="2025-04-15")

5. scrape_results()
   → flights: [{price: "$1,020", airline: "ANA", stops: 1, duration: "17h 40m"}, ...]

6. Report comparison table to user.
```
