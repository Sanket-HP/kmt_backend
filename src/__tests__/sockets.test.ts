import * as http from 'http';
import { AddressInfo } from 'net';
import { WebSocket, WebSocketServer } from 'ws';
import { setupWebSocketServer } from '../sockets/tracker';

jest.mock('../services/db', () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        update: jest.fn().mockResolvedValue({})
      }))
    }))
  }
}));

describe('KMT WebSocket Telemetry Broker Integration Tests', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let port: number;
  let clients: WebSocket[] = [];

  beforeAll((done) => {
    server = http.createServer();
    wss = new WebSocketServer({ server });
    setupWebSocketServer(wss);
    server.listen(0, () => {
      const address = server.address() as AddressInfo;
      port = address.port;
      done();
    });
  });

  afterAll((done) => {
    clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN || c.readyState === WebSocket.CONNECTING) {
        c.close();
      }
    });
    wss.close(() => {
      server.close(() => {
        done();
      });
    });
  });

  const createClient = (): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}`);
      clients.push(ws);
      ws.on('open', () => resolve(ws));
      ws.on('error', (err) => reject(err));
    });
  };

  it('should allow clients to connect and subscribe to routes', async () => {
    const ws = await createClient();
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('should broadcast location updates to passengers subscribed to the route', (done) => {
    Promise.all([createClient(), createClient()]).then(([passenger, driver]) => {
      // 1. Passenger subscribes to Route 10A
      passenger.send(JSON.stringify({
        action: 'subscribe',
        routeId: 'route_10A'
      }));

      // 2. Wait for passenger to receive messages
      passenger.on('message', (message: string) => {
        const payload = JSON.parse(message);
        expect(payload.event).toBe('location_broadcast');
        expect(payload.routeId).toBe('route_10A');
        expect(payload.tripId).toBe('trip_abc');
        expect(payload.telemetry.latitude).toBe(16.7050);
        expect(payload.telemetry.longitude).toBe(74.2433);
        done();
      });

      // Give connection a tiny millisecond slice to register subscription on tracker
      setTimeout(() => {
        // 3. Driver broadcasts coordinates
        driver.send(JSON.stringify({
          action: 'location_update',
          tripId: 'trip_abc',
          routeId: 'route_10A',
          latitude: 16.7050,
          longitude: 74.2433,
          speed: 40
        }));
      }, 50);
    }).catch(done);
  });

  it('should broadcast location updates to admin fleet subscribers regardless of route', (done) => {
    Promise.all([createClient(), createClient(), createClient()]).then(([passengerRouteA, adminFleet, driverRouteB]) => {
      // 1. Route A passenger subscribes to 10A
      passengerRouteA.send(JSON.stringify({
        action: 'subscribe',
        routeId: 'route_10A'
      }));

      // 2. Admin dashboard subscribes to all Fleet updates
      adminFleet.send(JSON.stringify({
        action: 'subscribe_fleet'
      }));

      let passengerReceived = false;
      passengerRouteA.on('message', () => {
        passengerReceived = true;
      });

      adminFleet.on('message', (message: string) => {
        const payload = JSON.parse(message);
        expect(payload.event).toBe('location_broadcast');
        expect(payload.routeId).toBe('route_20B');
        
        // Assert that the passenger subscribed to 10A never received this update for 20B
        expect(passengerReceived).toBe(false);
        done();
      });

      setTimeout(() => {
        // 3. Driver broadcasts updates on Route 20B
        driverRouteB.send(JSON.stringify({
          action: 'location_update',
          tripId: 'trip_xyz',
          routeId: 'route_20B',
          latitude: 16.8112,
          longitude: 74.1500,
          speed: 35
        }));
      }, 50);
    }).catch(done);
  });
});
