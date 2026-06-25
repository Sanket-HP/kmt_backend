import { WebSocket, WebSocketServer } from 'ws';
import { db } from '../services/db';

interface ClientSubscription {
  ws: WebSocket;
  routeId?: string;
  isFleet?: boolean;
}

// Stores active web socket connections and their subscription channels
const subscriptions = new Set<ClientSubscription>();

export const setupWebSocketServer = (wss: WebSocketServer) => {
  console.log('[WebSocket Broker] Setup completed. Listening for live updates.');

  wss.on('connection', (ws: WebSocket) => {
    const clientSub: ClientSubscription = { ws };
    subscriptions.add(clientSub);

    ws.on('message', async (message: string) => {
      try {
        const payload = JSON.parse(message);
        
        switch (payload.action) {
          case 'subscribe':
            // Subscribe passenger device to a specific route
            clientSub.routeId = payload.routeId;
            clientSub.isFleet = false;
            console.log(`[WebSocket Broker] Passenger subscribed to Route: ${payload.routeId}`);
            break;

          case 'subscribe_fleet':
            // Subscribe admin operations dashboard to all bus updates
            clientSub.isFleet = true;
            clientSub.routeId = undefined;
            console.log('[WebSocket Broker] Admin dashboard subscribed to active Fleet updates');
            break;

          case 'location_update':
            // Received location update from Driver device
            const { tripId, routeId, latitude, longitude, speed } = payload;
            if (!tripId || !routeId) break;

            const telemetry = {
              latitude: parseFloat(latitude),
              longitude: parseFloat(longitude),
              speed: parseFloat(speed) || 0,
              timestamp: Date.now()
            };

            // 1. Broadcast update to subscribed clients
            broadcastLocation(tripId, routeId, telemetry);

            // 2. Write location update asynchronously to Firestore trip document
            db.collection('trips').doc(tripId).update({
              currentLocation: telemetry
            }).catch(e => {
              console.warn(`[WebSocket Broker] Failed to write telemetry to Firestore for Trip ${tripId}:`, e.message);
            });
            break;

          default:
            console.log(`[WebSocket Broker] Unknown action: ${payload.action}`);
        }
      } catch (err: any) {
        console.warn('[WebSocket Broker] Invalid websocket message input:', err.message || err);
      }
    });

    ws.on('close', () => {
      subscriptions.delete(clientSub);
    });

    ws.on('error', (error) => {
      console.error('[WebSocket Broker] Connection socket error:', error);
      subscriptions.delete(clientSub);
    });
  });
};

const broadcastLocation = (tripId: string, routeId: string, telemetry: any) => {
  const payloadStr = JSON.stringify({
    event: 'location_broadcast',
    tripId,
    routeId,
    telemetry
  });

  for (const client of subscriptions) {
    if (client.ws.readyState === WebSocket.OPEN) {
      const shouldSend = client.isFleet || (client.routeId === routeId);
      if (shouldSend) {
        client.ws.send(payloadStr);
      }
    }
  }
};
