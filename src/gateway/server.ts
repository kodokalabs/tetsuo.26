// ============================================================
// Gateway — HTTP + WebSocket control plane
// HARDENED: auth, rate limiting, CORS, size limits, filtered WS
// ============================================================

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { IncomingMessage } from 'http';
import { gatewayConfig, agentConfig, securityConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { eventBus } from '../events.js';
import {
  initGatewayAuth,
  validateGatewayToken,
  checkRateLimit,
  audit,
} from '../security/guard.js';
import { getAllSkills } from '../skills/loader.js';
import { getAllMemories } from '../memory/store.js';
import { createAdminRouter } from '../admin/dashboard.js';
import type { AgentEvent } from '../types.js';

const log = createLogger('Gateway');

let wss: WebSocketServer;

// ---- Extract client IP helper --------------------------------
function clientIP(req: IncomingMessage): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    || req.socket.remoteAddress
    || 'unknown';
}

// ---- Extract bearer token ------------------------------------
function extractToken(req: IncomingMessage): string | null {
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  // Also accept as query param for WebSocket connections
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  return url.searchParams.get('token');
}

export async function startGateway(): Promise<void> {
  // Initialize auth token
  const token = await initGatewayAuth();

  const app = express();

  // ---- Security middleware ------------------------------------

  // Request size limit
  app.use(express.json({ limit: `${securityConfig.maxRequestBodyBytes}b` }));

  // CORS: only allow same-origin by default (localhost)
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', `http://${gatewayConfig.host}:${gatewayConfig.port}`);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Authentication middleware (all routes except /health)
  app.use((req, res, next) => {
    // Health check is unauthenticated (for monitoring)
    if (req.path === '/health') return next();

    const ip = clientIP(req);

    // Rate limiting
    if (!checkRateLimit(`http:${ip}`, securityConfig.gatewayRateLimitPerMin, securityConfig.gatewayRateLimitPerMin / 60)) {
      audit({ action: 'rate_limit', reason: `HTTP rate limit exceeded by ${ip}`, blocked: true });
      res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
      return;
    }

    // Token validation
    if (securityConfig.gatewayAuthEnabled) {
      const reqToken = req.headers['authorization']?.replace('Bearer ', '');
      if (!validateGatewayToken(reqToken)) {
        audit({ action: 'auth_fail', reason: `Invalid token from ${ip}`, blocked: true });
        res.status(401).json({ error: 'Unauthorized. Provide a valid Bearer token.' });
        return;
      }
    }

    next();
  });

  // ---- REST Endpoints ----------------------------------------

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      agent: agentConfig.name,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/status', async (_req, res) => {
    const skills = getAllSkills();
    const memories = await getAllMemories();
    res.json({
      agent: agentConfig.name,
      provider: agentConfig.provider,
      model: agentConfig.model,
      autonomy: agentConfig.autonomyLevel,
      skills: skills.map(s => ({ name: s.name, description: s.description })),
      memoryCount: memories.length,
      uptime: process.uptime(),
    });
  });

  app.get('/skills', (_req, res) => {
    res.json(getAllSkills().map(s => ({
      name: s.name,
      description: s.description,
      triggers: s.triggers,
      version: s.version,
    })));
  });

  app.get('/memory', async (_req, res) => {
    const memories = await getAllMemories();
    res.json(memories);
  });

  // ---- Admin Dashboard (authenticated via middleware above) ---
  app.use('/admin', createAdminRouter());

  // Catch-all: reject unknown routes
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // ---- HTTP Server + WebSocket --------------------------------

  const server = http.createServer(app);

  wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: securityConfig.maxRequestBodyBytes,
    // Authenticate WebSocket upgrade requests
    verifyClient: (info: { req: IncomingMessage }, callback) => {
      const ip = clientIP(info.req);

      // Rate limit
      if (!checkRateLimit(`ws:${ip}`, 10, 0.5)) {
        audit({ action: 'rate_limit', reason: `WS rate limit: ${ip}`, blocked: true });
        callback(false, 429, 'Rate limit exceeded');
        return;
      }

      // Auth
      if (securityConfig.gatewayAuthEnabled) {
        const reqToken = extractToken(info.req);
        if (!validateGatewayToken(reqToken)) {
          audit({ action: 'auth_fail', reason: `WS auth fail: ${ip}`, blocked: true });
          callback(false, 401, 'Unauthorized');
          return;
        }
      }

      callback(true);
    },
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const ip = clientIP(req);
    log.info(`WebSocket client connected from ${ip}`);

    ws.send(JSON.stringify({
      type: 'connected',
      agent: agentConfig.name,
      timestamp: new Date().toISOString(),
    }));

    ws.on('message', (data: Buffer) => {
      try {
        // Size check
        if (data.length > securityConfig.maxRequestBodyBytes) {
          ws.send(JSON.stringify({ type: 'error', message: 'Message too large' }));
          return;
        }
        const msg = JSON.parse(data.toString());
        handleWSCommand(ws, msg);
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    });

    ws.on('close', () => {
      log.debug('WebSocket client disconnected');
    });
  });

  // Broadcast SAFE agent events to WebSocket clients
  // Filter out events that may contain sensitive data
  eventBus.on('*', (event: AgentEvent) => {
    broadcastWS(sanitizeEvent(event));
  });

  server.listen(gatewayConfig.port, gatewayConfig.host, () => {
    log.info(`Gateway listening on http://${gatewayConfig.host}:${gatewayConfig.port}`);
    log.info(`WebSocket at ws://${gatewayConfig.host}:${gatewayConfig.port}/ws`);
    if (securityConfig.gatewayAuthEnabled) {
      log.info(`Auth enabled — token stored in ${agentConfig.workspace}/.gateway-token`);
    }
  });
}

/** Strip sensitive data from events before broadcasting */
function sanitizeEvent(event: AgentEvent): Record<string, unknown> {
  switch (event.type) {
    case 'tool_called':
      // Don't broadcast full tool inputs (may contain file contents, secrets)
      return {
        type: event.type,
        tool: event.tool,
        inputKeys: Object.keys(event.input),
        timestamp: new Date().toISOString(),
      };
    case 'tool_result':
      // Don't broadcast full tool results
      return {
        type: event.type,
        tool: event.tool,
        isError: event.isError,
        resultPreview: event.result.slice(0, 200),
        timestamp: new Date().toISOString(),
      };
    case 'message_received':
      return {
        type: event.type,
        channel: event.message.channel,
        userName: event.message.userName,
        textPreview: event.message.text.slice(0, 100),
        timestamp: new Date().toISOString(),
      };
    default:
      return { ...event, timestamp: new Date().toISOString() };
  }
}

function broadcastWS(data: unknown): void {
  if (!wss) return;
  const payload = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function handleWSCommand(ws: WebSocket, msg: any): void {
  switch (msg.type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
      break;
    case 'status':
      ws.send(JSON.stringify({
        type: 'status',
        agent: agentConfig.name,
        uptime: process.uptime(),
      }));
      break;
    default:
      ws.send(JSON.stringify({ type: 'unknown_command', received: msg.type }));
  }
}
