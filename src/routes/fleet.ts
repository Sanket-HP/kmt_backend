import { Router, Response } from 'express';
import { AuthenticatedRequest, authenticateToken, requireRole } from '../middleware/auth';
import { db } from '../services/db';

const router = Router();

/**
 * Dispatch route - assigns bus, route, driver, conductor to create a scheduled/active Trip in Firestore.
 */
router.post('/dispatch', authenticateToken, requireRole(['admin']), async (req: AuthenticatedRequest, res: Response) => {
  const { busId, routeId, driverId, conductorId, timetableTime } = req.body;

  if (!busId || !routeId || !driverId || !conductorId) {
    return res.status(400).json({ error: 'Missing dispatch configuration details.' });
  }

  try {
    // 1. Validate driver exists
    const driverSnap = await db.collection('users').doc(driverId).get();
    if (!driverSnap.exists || driverSnap.data()?.role !== 'driver') {
      return res.status(400).json({ error: 'Selected driver is invalid or not registered.' });
    }

    // 2. Validate conductor exists
    const conductorSnap = await db.collection('users').doc(conductorId).get();
    if (!conductorSnap.exists || conductorSnap.data()?.role !== 'conductor') {
      return res.status(400).json({ error: 'Selected conductor is invalid or not registered.' });
    }

    // 3. Validate bus status
    const busSnap = await db.collection('buses').doc(busId).get();
    if (!busSnap.exists) {
      return res.status(404).json({ error: 'Bus not found.' });
    }
    if (busSnap.data()?.status === 'maintenance') {
      return res.status(400).json({ error: 'Bus is suspended in maintenance and cannot be dispatched.' });
    }

    // 4. Create active trip document in Firestore (real-time sync to clients)
    const tripId = 'trip_' + Math.random().toString(36).substr(2, 9);
    const newTrip = {
      tripId,
      busId,
      routeId,
      driverId,
      conductorId,
      status: 'scheduled',
      passengerCount: 0,
      occupancy: 'low',
      createdAt: Date.now(),
      scheduledDeparture: timetableTime || '09:00',
      currentLocation: {
        latitude: 16.7050, // Default CBS Kolhapur
        longitude: 74.2433,
        speed: 0,
        timestamp: Date.now()
      }
    };

    await db.collection('trips').doc(tripId).set(newTrip);
    
    // 5. Update bus active reference
    await db.collection('buses').doc(busId).update({ currentTripId: tripId });

    return res.status(200).json({ success: true, trip: newTrip });
  } catch (error: any) {
    console.error('[Dispatch Router] Dispatch failure:', error);
    return res.status(500).json({ error: error.message || 'Internal server dispatch error.' });
  }
});

/**
 * Suspend/active vehicle status modification endpoint.
 */
router.post('/bus/status', authenticateToken, requireRole(['admin']), async (req: AuthenticatedRequest, res: Response) => {
  const { busId, status } = req.body;
  
  if (!busId || !status) {
    return res.status(400).json({ error: 'Missing busId or status parameter.' });
  }

  try {
    await db.collection('buses').doc(busId).update({ status });
    return res.status(200).json({ success: true, message: `Bus status updated to ${status}.` });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Cancels active trip schedules and broadcasts operational delay notices.
 */
router.post('/trip/cancel', authenticateToken, requireRole(['admin']), async (req: AuthenticatedRequest, res: Response) => {
  const { tripId } = req.body;

  if (!tripId) {
    return res.status(400).json({ error: 'Missing tripId parameter.' });
  }

  try {
    const tripRef = db.collection('trips').doc(tripId);
    const tripSnap = await tripRef.get();
    if (!tripSnap.exists) {
      return res.status(404).json({ error: 'Trip not found.' });
    }

    const tripData = tripSnap.data();
    await tripRef.update({ status: 'ended', endedAt: Date.now() });

    if (tripData?.busId) {
      await db.collection('buses').doc(tripData.busId).update({ currentTripId: null });
    }

    // Broadcast cancellation notices
    const routeSnap = await db.collection('routes').doc(tripData?.routeId).get();
    const routeNum = routeSnap.exists ? routeSnap.data()?.routeNumber : 'N/A';
    
    const notifId = 'notif_' + Math.random().toString(36).substr(2, 9);
    await db.collection('notifications').doc(notifId).set({
      notificationId: notifId,
      title: 'TRIP CANCELLATION NOTICE',
      body: `The scheduled bus trip on Route ${routeNum} has been cancelled due to operational constraints. Please check alternate routes.`,
      type: 'delay',
      routeId: tripData?.routeId || null,
      timestamp: Date.now()
    });

    return res.status(200).json({ success: true, message: 'Trip successfully cancelled and notification broadcasted.' });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

export default router;
