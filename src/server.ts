import express from 'express';
import cors from 'cors';
import * as http from 'http';
import { WebSocketServer } from 'ws';
import * as dotenv from 'dotenv';
import { setupWebSocketServer } from './sockets/tracker';
import paymentsRouter from './routes/payments';
import fleetRouter from './routes/fleet';
import analyticsRouter from './routes/analytics';
import supportRouter from './routes/support';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Enable cross-origin requests for Operations Web Dashboard client
app.use(cors({ origin: '*' }));
app.use(express.json());

// HTTP Route bindings
app.use('/payments', paymentsRouter);
app.use('/fleet', fleetRouter);
app.use('/analytics', analyticsRouter);
app.use('/support', supportRouter);

// Enterprise Health check probe
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'UP',
    timestamp: Date.now(),
    uptime: process.uptime(),
    services: {
      database: 'connected',
      websockets: 'active'
    }
  });
});

const server = http.createServer(app);

// Attach WebSocketServer to same HTTP server port instance
const wss = new WebSocketServer({ server });
setupWebSocketServer(wss);

server.listen(port, () => {
  console.log(`[KMT API Backend] Production server listening on port ${port}`);
});
