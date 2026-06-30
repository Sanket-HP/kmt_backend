import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

const envFile = `.env.${process.env.NODE_ENV || 'development'}`;
const envPath = path.resolve(process.cwd(), envFile);
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  console.log(`[KMT Control] Loaded environment config: ${envFile}`);
} else {
  const rootEnvPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(rootEnvPath)) {
    dotenv.config({ path: rootEnvPath });
    console.log("[KMT Control] Loaded root level default environment config.");
  } else {
    dotenv.config();
    console.log("[KMT Control] Loaded default environment configuration.");
  }
}

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import * as http from 'http';
import { WebSocketServer } from 'ws';
import * as admin from 'firebase-admin';
import { setupWebSocketServer } from './sockets/tracker';
import paymentsRouter from './routes/payments';
import fleetRouter from './routes/fleet';
import analyticsRouter from './routes/analytics';
import supportRouter from './routes/support';
import authRouter from './routes/auth';
import adminRouter from './routes/admin';
import ticketsRouter from './routes/tickets';
import { bootstrapAdmin } from './services/bootstrap';

const app = express();
const port = process.env.PORT || 3000;
const version = '1.0.0';

// 1. Security & Performance Middlewares
app.use(helmet());
app.use(compression());
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 2. Custom Logger Middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[HTTP] ${req.method} ${req.originalUrl} - ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// 3. Custom In-Memory Rate Limiter Middleware
const rateLimitWindowMs = 15 * 60 * 1000; // 15 minutes
const rateLimitMaxRequests = 1000; // Limit each IP to 1000 requests per window
const ipRequestCounts = new Map<string, { count: number; resetTime: number }>();

app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const limitInfo = ipRequestCounts.get(ip);

  if (!limitInfo || now > limitInfo.resetTime) {
    ipRequestCounts.set(ip, {
      count: 1,
      resetTime: now + rateLimitWindowMs
    });
    next();
  } else if (limitInfo.count >= rateLimitMaxRequests) {
    res.status(429).json({ error: 'Too many requests. Please try again later.' });
  } else {
    limitInfo.count++;
    next();
  }
});

// Flag to track WebSocket status
let isWebSocketActive = false;

// 4. Production Root Endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    service: 'KMT Connect Backend',
    status: 'UP',
    version,
    environment: process.env.NODE_ENV || 'production',
    timestamp: new Date().toISOString()
  });
});

// 5. Enterprise Health Check Endpoint
app.get('/health', async (req, res) => {
  let dbStatus = 'disconnected';
  let firebaseStatus = 'disconnected';

  try {
    if (admin.apps.length > 0) {
      firebaseStatus = 'connected';
      // Lightweight Firestore check
      const db = admin.firestore();
      await db.collection('settings').doc('ping').get();
      dbStatus = 'connected';
    }
  } catch (error: any) {
    console.warn('[Health Check Warning] Database status failed:', error.message || error);
  }

  const isHealthy = firebaseStatus === 'connected' && dbStatus === 'connected';

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'UP' : 'DOWN',
    database: dbStatus,
    firebase: firebaseStatus,
    websocket: isWebSocketActive ? 'running' : 'stopped',
    uptime: process.uptime(),
    version
  });
});

// 6. API Discovery Endpoint
app.get('/api', (req, res) => {
  res.status(200).json({
    fleet: '/api/fleet',
    payments: '/api/payments',
    analytics: '/api/analytics',
    support: '/api/support'
  });
});

// 7. Double-Mounted HTTP Route Bindings
// Base routes (for backward compatibility with old web portal & mobile app)
app.use('/payments', paymentsRouter);
app.use('/fleet', fleetRouter);
app.use('/analytics', analyticsRouter);
app.use('/support', supportRouter);
app.use('/auth', authRouter);
app.use('/admin', adminRouter);
app.use('/tickets', ticketsRouter);
app.use('/passes', ticketsRouter);

// API namespaced routes (for standard clean architecture conformance)
app.use('/api/payments', paymentsRouter);
app.use('/api/fleet', fleetRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/support', supportRouter);
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/tickets', ticketsRouter);
app.use('/api/passes', ticketsRouter);

// 8. Wildcard 404 Handler
app.use((req, res, next) => {
  res.status(404).json({ error: 'Endpoint not found.' });
});

// 9. Global Error Catching Middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('[Global Error Handler]:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error'
  });
});

const server = http.createServer(app);

// Attach WebSocketServer to same HTTP server port instance
const wss = new WebSocketServer({ server });
setupWebSocketServer(wss);
isWebSocketActive = true;

// Graceful Shutdown Handler
const gracefulShutdown = () => {
  console.log('[KMT Backend] Initiating graceful shutdown...');
  server.close(() => {
    console.log('[KMT Backend] HTTP server closed.');
    wss.close(() => {
      console.log('[KMT Backend] WebSocket server closed.');
      process.exit(0);
    });
  });

  // Force close after 10s if sockets linger
  setTimeout(() => {
    console.error('[KMT Backend] Force shutdown due to lingering connections.');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

server.listen(port, async () => {
  console.log(`[KMT API Backend] Production server listening on port ${port}`);
  await bootstrapAdmin();
});
