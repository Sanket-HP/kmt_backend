import express from 'express';
import * as http from 'http';
import { AddressInfo } from 'net';
import { WebSocket, WebSocketServer } from 'ws';
import { setupWebSocketServer } from '../sockets/tracker';
import paymentsRouter from '../routes/payments';
import fleetRouter from '../routes/fleet';
import analyticsRouter from '../routes/analytics';
import supportRouter from '../routes/support';

// Mock Firebase Admin globally so the load test doesn't write to production Firestore
jest.mock('firebase-admin', () => {
  const getMock = jest.fn().mockResolvedValue({
    exists: true,
    data: () => ({ role: 'passenger', name: 'Load Test Payer' })
  });
  const setMock = jest.fn().mockResolvedValue({});
  const updateMock = jest.fn().mockResolvedValue({});

  const collectionMock = jest.fn(() => ({
    doc: jest.fn(() => ({
      get: getMock,
      set: setMock,
      update: updateMock
    })),
    where: jest.fn(() => ({
      get: jest.fn().mockResolvedValue({
        size: 1,
        docs: [{ id: 't_1', data: () => ({ status: 'pending' }) }]
      })
    })),
    get: jest.fn().mockResolvedValue({ size: 1, docs: [] })
  }));

  const firestoreMock = jest.fn(() => ({
    collection: collectionMock
  })) as any;
  
  firestoreMock.FieldValue = {
    arrayUnion: jest.fn((val) => [val])
  };

  return {
    initializeApp: jest.fn(),
    apps: [],
    credential: { cert: jest.fn() },
    firestore: Object.assign(() => firestoreMock(), { FieldValue: firestoreMock.FieldValue }),
    auth: () => ({
      verifyIdToken: jest.fn().mockResolvedValue({ uid: 'load_user_123', email: 'load@kmt.gov.in' })
    })
  };
});

// Setup Server
const app = express();
app.use(express.json());
app.use('/payments', paymentsRouter);
app.use('/fleet', fleetRouter);
app.use('/analytics', analyticsRouter);
app.use('/support', supportRouter);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
setupWebSocketServer(wss);

async function runLoadSimulation() {
  console.log('\n==================================================');
  console.log('🚀 INITIALIZING KMT CONNECT LOAD & SCALABILITY TEST');
  console.log('==================================================\n');

  // Start server on dynamic port
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://localhost:${port}`;
  const wsUrl = `ws://localhost:${port}`;
  console.log(`[Load Test] Server listening on dynamic port ${port}`);

  const DRIVER_COUNT = 50;
  const CONCURRENT_PURCHASES = 200;
  console.log(`[Load Test] Spawning ${DRIVER_COUNT} virtual driver GPS trackers...`);
  console.log(`[Load Test] Queuing ${CONCURRENT_PURCHASES} concurrent ticket checkout API transactions...`);

  // 1. Spawn WebSocket Drivers
  const driverSockets: WebSocket[] = [];
  let wsMessagesSent = 0;
  let wsErrors = 0;

  for (let i = 0; i < DRIVER_COUNT; i++) {
    const ws = new WebSocket(wsUrl);
    driverSockets.push(ws);
    ws.on('error', () => {
      wsErrors++;
    });
  }

  // Allow WebSockets a brief window to establish handshake
  await new Promise(r => setTimeout(r, 200));

  // Trigger periodic coordinate broadcasts (GPS Updates)
  const gpsInterval = setInterval(() => {
    driverSockets.forEach((ws, idx) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          action: 'location_update',
          tripId: `trip_load_${idx}`,
          routeId: 'route_10A',
          latitude: 16.7050 + Math.random() * 0.01,
          longitude: 74.2433 + Math.random() * 0.01,
          speed: 30 + Math.random() * 15
        }));
        wsMessagesSent++;
      }
    });
  }, 200);

  // 2. Perform Concurrent REST HTTP Transactions
  const startHttpTime = Date.now();
  let httpSuccess = 0;
  let httpFail = 0;
  const httpLatencies: number[] = [];

  const purchasePayload = {
    orderId: 'order_load_test',
    paymentId: 'pay_load_test',
    signature: 'a'.repeat(64),
    amount: 250,
    paymentMethod: 'upi',
    payerDetails: { name: 'Load Tester', phone: '9999999999', email: 'load@test.com' },
    itemId: 'ticket_load',
    itemType: 'ticket',
    billingDetails: { name: 'Load Tester', phone: '9999999999' }
  };

  console.log(`[Load Test] Triggering REST API storm in batches...`);
  const BATCH_SIZE = 50;
  for (let b = 0; b < CONCURRENT_PURCHASES; b += BATCH_SIZE) {
    const batchPromises = Array.from({ length: BATCH_SIZE }).map(async (_, idx) => {
      const globalIdx = b + idx;
      const reqStart = Date.now();
      try {
        const response = await fetch(`${baseUrl}/payments/verify`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer mock-load-token'
          },
          body: JSON.stringify({
            ...purchasePayload,
            paymentId: `pay_load_${globalIdx}`
          })
        });

        const latency = Date.now() - reqStart;
        httpLatencies.push(latency);

        if (response.status === 200) {
          httpSuccess++;
        } else {
          httpFail++;
          const text = await response.text();
          console.warn(`[Load Test Debug] Request failed with status ${response.status}: ${text}`);
        }
      } catch (e: any) {
        httpFail++;
        console.warn(`[Load Test Debug] Request threw exception: ${e.message}`);
        httpLatencies.push(Date.now() - reqStart);
      }
    });
    await Promise.all(batchPromises);
  }
  const totalHttpTime = Date.now() - startHttpTime;

  // Cleanup WebSockets
  clearInterval(gpsInterval);
  driverSockets.forEach(ws => ws.close());
  
  // Close Server
  wss.close();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  // 3. Compile Load Results
  const avgLatency = httpLatencies.reduce((a, b) => a + b, 0) / httpLatencies.length;
  const minLatency = Math.min(...httpLatencies);
  const maxLatency = Math.max(...httpLatencies);
  const throughput = (CONCURRENT_PURCHASES / (totalHttpTime / 1000)).toFixed(2);

  console.log('\n==================================================');
  console.log('📊 KMT CONNECT SCALABILITY REPORT');
  console.log('==================================================');
  console.log(`- WebSocket GPS Telemetry Updates Sent : ${wsMessagesSent}`);
  console.log(`- WebSocket Connection Failures        : ${wsErrors}`);
  console.log(`- REST API Requests Executed           : ${CONCURRENT_PURCHASES}`);
  console.log(`- REST API Transaction Successes       : ${httpSuccess}`);
  console.log(`- REST API Transaction Failures        : ${httpFail}`);
  console.log(`- Total Execution Time                 : ${totalHttpTime} ms`);
  console.log(`- Transaction Throughput               : ${throughput} req/sec`);
  console.log(`- Average API Latency                  : ${avgLatency.toFixed(2)} ms`);
  console.log(`- Minimum API Latency                  : ${minLatency} ms`);
  console.log(`- Maximum API Latency                  : ${maxLatency} ms`);
  console.log('==================================================\n');

  if (httpFail > 0 || wsErrors > 0) {
    console.error('❌ Load test finished with transaction failures.');
    throw new Error('Load test finished with transaction failures.');
  } else {
    console.log('✅ Load and scalability verification successful.');
  }
}

describe('KMT Scalability & Load Tests', () => {
  it('runs peak operation simulation successfully', async () => {
    await runLoadSimulation();
  }, 45000);
});
