#!/usr/bin/env node
/**
 * Flight MCP Bridge
 * - stdio MCP: for local Claude Code (spawned via "command": "node")
 * - SSE MCP:   for remote tailnet agents (GET /sse + POST /message)
 * - WS server: listens on ws://127.0.0.1:9222 for the Chrome Extension
 */

'use strict';

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { randomUUID } = require('crypto');

// ─── Constants ────────────────────────────────────────────────────────────────

const WS_PORT   = 9223;
const SSE_PORT  = 3000;
const TOOL_TIMEOUT_MS = 150_000;

const TOOLS = [
  {
    name: 'search_ita',
    description: 'Search ITA Matrix for theoretical lowest fares. To search business or first class you MUST pass the cabin parameter explicitly.',
    inputSchema: {
      type: 'object',
      properties: {
        origin:         { type: 'string', description: 'IATA airport code or city (e.g. TPE)' },
        destination:    { type: 'string', description: 'IATA airport code or city (e.g. NRT)' },
        departure_date: { type: 'string', description: 'Departure date YYYY-MM-DD' },
        return_date:    { type: 'string', description: 'Return date YYYY-MM-DD (omit for one-way)' },
        passengers:     { type: 'integer', description: 'Number of passengers', default: 1 },
        cabin:          { type: 'string', enum: ['economy', 'premium_economy', 'business', 'first'], description: 'Cabin class. Defaults to "economy" if omitted.' }
      },
      required: ['origin', 'destination', 'departure_date']
    }
  },
  {
    name: 'scrape_ita_results',
    description: 'Scrape current ITA Matrix results page for fare data including price, routing, fare class.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'search_flights',
    description: 'Search Google Flights to validate fares and get booking links.',
    inputSchema: {
      type: 'object',
      properties: {
        origin:         { type: 'string', description: 'IATA airport code or city (e.g. TPE)' },
        destination:    { type: 'string', description: 'IATA airport code or city (e.g. NRT)' },
        departure_date: { type: 'string', description: 'Departure date YYYY-MM-DD' },
        return_date:    { type: 'string', description: 'Return date YYYY-MM-DD (omit for one-way)' },
        passengers:     { type: 'integer', description: 'Number of passengers', default: 1 },
        cabin:          { type: 'string', enum: ['economy', 'premium_economy', 'business', 'first'], description: 'Cabin class. Defaults to "economy" if omitted.' }
      },
      required: ['origin', 'destination', 'departure_date']
    }
  },
  {
    name: 'search_flights_multicity',
    description: 'Search Google Flights for multi-city itineraries (up to 6 legs).',
    inputSchema: {
      type: 'object',
      properties: {
        legs: {
          type: 'array',
          description: 'Ordered list of flight legs',
          items: {
            type: 'object',
            properties: {
              origin:      { type: 'string', description: 'IATA departure airport' },
              destination: { type: 'string', description: 'IATA arrival airport' },
              date:        { type: 'string', description: 'Departure date YYYY-MM-DD' }
            },
            required: ['origin', 'destination', 'date']
          }
        },
        passengers: { type: 'integer', description: 'Number of passengers', default: 1 },
        cabin:      { type: 'string', enum: ['economy', 'premium_economy', 'business', 'first'], description: 'Cabin class. Defaults to "economy" if omitted.' }
      },
      required: ['legs']
    }
  },
  {
    name: 'scrape_results',
    description: 'Re-scrape current Google Flights results without navigating.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'search_ita_multicity',
    description: 'Search ITA Matrix for multi-city itineraries (2–6 legs). Ideal for 外站票 (external-origin tickets) and open-jaw routes.',
    inputSchema: {
      type: 'object',
      properties: {
        legs: {
          type: 'array',
          description: 'Ordered list of flight legs',
          items: {
            type: 'object',
            properties: {
              origin:      { type: 'string', description: 'IATA departure airport (e.g. NRT)' },
              destination: { type: 'string', description: 'IATA arrival airport (e.g. TPE)' },
              date:        { type: 'string', description: 'Departure date YYYY-MM-DD' }
            },
            required: ['origin', 'destination', 'date']
          }
        },
        passengers: { type: 'integer', description: 'Number of passengers', default: 1 },
        cabin:      { type: 'string', enum: ['economy', 'premium_economy', 'business', 'first'], description: 'Cabin class. Defaults to "economy" if omitted.' }
      },
      required: ['legs']
    }
  }
];

// ─── State ────────────────────────────────────────────────────────────────────

/** The single Extension WebSocket connection */
let extensionWs = null;

/** Pending tool calls: requestId → { resolve, reject, timer } */
const pending = new Map();

/** Active SSE sessions: sessionId → res (ServerResponse) */
const sseSessions = new Map();

// ─── Extension WebSocket Server (127.0.0.1:9222) ─────────────────────────────

const wss = new WebSocketServer({ host: '127.0.0.1', port: WS_PORT });

wss.on('listening', () => {
  stderr(`[bridge] Extension WS server listening on ws://127.0.0.1:${WS_PORT}`);
});

wss.on('connection', (ws) => {
  stderr('[bridge] Extension connected');
  extensionWs = ws;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { requestId, result, error } = msg;
    if (!requestId || !pending.has(requestId)) return;

    const { resolve, reject, timer } = pending.get(requestId);
    pending.delete(requestId);
    clearTimeout(timer);

    if (error) reject(new Error(error));
    else resolve(result);
  });

  ws.on('close', () => {
    stderr('[bridge] Extension disconnected');
    extensionWs = null;
    // reject all pending calls
    for (const [id, { reject, timer }] of pending) {
      clearTimeout(timer);
      reject(new Error('Extension disconnected'));
    }
    pending.clear();
  });

  ws.on('error', (err) => stderr('[bridge] Extension WS error:', err.message));
});

// ─── Core MCP Handler ─────────────────────────────────────────────────────────

async function handleRpc(req) {
  const { id, method, params } = req;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'flight-mcp-bridge', version: '1.0.0' },
        capabilities: { tools: {} }
      }
    };
  }

  if (method === 'notifications/initialized') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    stderr(`[bridge] Tool call: ${name} with args: ${JSON.stringify(args)}`);
    try {
      const result = await callExtensionTool(name, args || {});
      return {
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        }
      };
    } catch (err) {
      return {
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true
        }
      };
    }
  }

  return {
    jsonrpc: '2.0', id,
    error: { code: -32601, message: `Method not found: ${method}` }
  };
}

function callExtensionTool(tool, params) {
  return new Promise((resolve, reject) => {
    if (!extensionWs || extensionWs.readyState !== WebSocket.OPEN) {
      return reject(new Error(
        'Chrome Extension is not connected. Please ensure Brave Browser is open with the Flight MCP Bridge extension enabled.'
      ));
    }

    const requestId = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Tool call timed out after ${TOOL_TIMEOUT_MS / 1000}s (tool: ${tool})`));
    }, TOOL_TIMEOUT_MS);

    pending.set(requestId, { resolve, reject, timer });
    extensionWs.send(JSON.stringify({ requestId, tool, params }));
  });
}

// ─── stdio Mode ───────────────────────────────────────────────────────────────

const isSpawned = !process.stdin.isTTY;

if (isSpawned) {
  stderr('[bridge] stdio mode active');

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let req;
      try { req = JSON.parse(line); } catch { continue; }
      handleRpc(req).then((resp) => {
        if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
      }).catch((err) => stderr('[bridge] stdio handler error:', err));
    }
  });

  process.stdin.on('end', () => process.exit(0));
}

// ─── SSE / HTTP Server ────────────────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Health check
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      extension_connected: extensionWs !== null && extensionWs.readyState === WebSocket.OPEN,
      active_sessions: sseSessions.size
    }));
  }

  // SSE endpoint — remote agents connect here
  if (req.method === 'GET' && url.pathname === '/sse') {
    const sessionId = randomUUID();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    sseSessions.set(sessionId, res);
    stderr(`[bridge] SSE session opened: ${sessionId}`);

    // Tell client where to POST messages
    res.write(`event: endpoint\ndata: /message?session_id=${sessionId}\n\n`);

    // Keepalive
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);

    req.on('close', () => {
      clearInterval(ping);
      sseSessions.delete(sessionId);
      stderr(`[bridge] SSE session closed: ${sessionId}`);
    });
    return;
  }

  // Message endpoint — remote agents POST JSON-RPC here
  if (req.method === 'POST' && url.pathname === '/message') {
    const sessionId = url.searchParams.get('session_id');
    if (!sessionId || !sseSessions.has(sessionId)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'session not found' }));
    }

    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let rpcReq;
      try { rpcReq = JSON.parse(body); } catch {
        res.writeHead(400);
        return res.end('bad json');
      }

      // Acknowledge immediately
      res.writeHead(202);
      res.end();

      handleRpc(rpcReq).then((resp) => {
        const sseRes = sseSessions.get(sessionId);
        if (resp && sseRes) {
          sseRes.write(`event: message\ndata: ${JSON.stringify(resp)}\n\n`);
        }
      }).catch((err) => stderr('[bridge] SSE handler error:', err));
    });
    return;
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  res.writeHead(404);
  res.end('not found');
});

httpServer.listen(SSE_PORT, '0.0.0.0', () => {
  stderr(`[bridge] SSE server listening on http://0.0.0.0:${SSE_PORT}`);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stderr(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

process.on('uncaughtException', (err) => stderr('[bridge] uncaughtException:', err.message));
process.on('unhandledRejection', (err) => stderr('[bridge] unhandledRejection:', err));
