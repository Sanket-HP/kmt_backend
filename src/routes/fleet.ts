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
 * GET /api/fleet/my-duty
 * Fetch today's assigned duty for the logged-in driver or conductor.
 */
router.get('/my-duty', authenticateToken, requireRole(['driver', 'conductor']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const uid = req.user?.uid;
    const role = req.user?.role;
    const dateStr = new Date().toISOString().split('T')[0];

    const fieldName = role === 'driver' ? 'driverId' : 'conductorId';
    const dutiesSnap = await db.collection('duties')
      .where(fieldName, '==', uid)
      .where('date', '==', dateStr)
      .limit(1)
      .get();

    if (dutiesSnap.empty) {
      // Fallback: search for any assigned/active duty
      const fallbackSnap = await db.collection('duties')
        .where(fieldName, '==', uid)
        .where('status', 'in', ['assigned', 'active'])
        .limit(1)
        .get();

      if (fallbackSnap.empty) {
        return res.status(200).json({ success: false, message: 'No duty assigned.' });
      }
      return res.status(200).json({ success: true, duty: fallbackSnap.docs[0].data() });
    }

    return res.status(200).json({ success: true, duty: dutiesSnap.docs[0].data() });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to retrieve duty.' });
  }
});

/**
 * Creates/starts an active Trip in Firestore (For Drivers).
 * Now requires dutyId and verifies assignment.
 */
router.post('/trip/start', authenticateToken, requireRole(['driver', 'admin']), async (req: AuthenticatedRequest, res: Response) => {
  const { dutyId } = req.body;

  if (!dutyId) {
    return res.status(400).json({ error: 'Missing dutyId.' });
  }

  try {
    const dutyRef = db.collection('duties').doc(dutyId);
    const dutySnap = await dutyRef.get();
    if (!dutySnap.exists) {
      return res.status(404).json({ error: 'Assigned duty roster not found.' });
    }

    const dutyData = dutySnap.data()!;
    if (req.user?.role === 'driver' && dutyData.driverId !== req.user.uid) {
      return res.status(403).json({ error: 'This duty is not assigned to you.' });
    }

    const { busId, routeId } = dutyData;
    const tripId = 'trip_' + Math.random().toString(36).substr(2, 9);
    
    // Fetch route first stop coordinates if possible, else default to CBS
    const routeDoc = await db.collection('routes').doc(routeId).get();
    const routeData = routeDoc.exists ? routeDoc.data() : null;
    let firstStopLat = 16.7026;
    let firstStopLng = 74.2400;

    if (routeData && routeData.stops && routeData.stops.length > 0) {
      const stopDoc = await db.collection('stops').doc(routeData.stops[0]).get();
      if (stopDoc.exists) {
        firstStopLat = stopDoc.data()?.latitude || 16.7026;
        firstStopLng = stopDoc.data()?.longitude || 74.2400;
      }
    }

    const newTrip = {
      tripId,
      busId,
      routeId,
      driverId: req.user?.uid || 'unknown_driver',
      status: 'active',
      passengerCount: 0,
      occupancy: 'low',
      createdAt: Date.now(),
      currentLocation: {
        latitude: firstStopLat,
        longitude: firstStopLng,
        speed: 0,
        timestamp: Date.now()
      }
    };

    await db.collection('trips').doc(tripId).set(newTrip);
    await db.collection('buses').doc(busId).update({ currentTripId: tripId });
    await dutyRef.update({ status: 'active', tripId });

    return res.status(200).json({ success: true, tripId, trip: newTrip });
  } catch (error: any) {
    console.error('[Fleet Router] Start trip failed:', error);
    return res.status(500).json({ error: error.message || 'Internal server error.' });
  }
});

/**
 * Pauses active trip (For Drivers).
 */
router.post('/trip/pause', authenticateToken, requireRole(['driver', 'admin']), async (req: AuthenticatedRequest, res: Response) => {
  const { tripId } = req.body;
  if (!tripId) return res.status(400).json({ error: 'Missing tripId.' });

  try {
    await db.collection('trips').doc(tripId).update({ status: 'paused' });
    return res.status(200).json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Resumes active trip (For Drivers).
 */
router.post('/trip/resume', authenticateToken, requireRole(['driver', 'admin']), async (req: AuthenticatedRequest, res: Response) => {
  const { tripId } = req.body;
  if (!tripId) return res.status(400).json({ error: 'Missing tripId.' });

  try {
    await db.collection('trips').doc(tripId).update({ status: 'active' });
    return res.status(200).json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Ends active trip (For Drivers).
 */
router.post('/trip/end', authenticateToken, requireRole(['driver', 'admin']), async (req: AuthenticatedRequest, res: Response) => {
  const { tripId } = req.body;
  if (!tripId) return res.status(400).json({ error: 'Missing tripId.' });

  try {
    const tripRef = db.collection('trips').doc(tripId);
    const tripSnap = await tripRef.get();
    if (!tripSnap.exists) return res.status(404).json({ error: 'Trip not found.' });

    const tripData = tripSnap.data();
    await tripRef.update({ status: 'ended', endedAt: Date.now() });

    if (tripData?.busId) {
      await db.collection('buses').doc(tripData.busId).update({ currentTripId: null });
    }

    const dutiesQuery = await db.collection('duties').where('tripId', '==', tripId).limit(1).get();
    if (!dutiesQuery.empty) {
      await dutiesQuery.docs[0].ref.update({ status: 'completed' });
    }

    return res.status(200).json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Updates trip occupancy level (For Drivers).
 */
router.post('/trip/occupancy', authenticateToken, requireRole(['driver', 'admin']), async (req: AuthenticatedRequest, res: Response) => {
  const { tripId, level } = req.body;
  if (!tripId || !level) return res.status(400).json({ error: 'Missing tripId or level.' });

  try {
    await db.collection('trips').doc(tripId).update({ occupancy: level });
    return res.status(200).json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Updates trip passenger count (For Conductors/Drivers).
 */
router.post('/trip/passenger-count', authenticateToken, requireRole(['conductor', 'driver', 'admin']), async (req: AuthenticatedRequest, res: Response) => {
  const { tripId, passengerCount } = req.body;
  if (!tripId || passengerCount === undefined) return res.status(400).json({ error: 'Missing tripId or passengerCount.' });

  try {
    await db.collection('trips').doc(tripId).update({ passengerCount });
    return res.status(200).json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Reports a vehicle breakdown (For Drivers).
 */
router.post('/trip/breakdown', authenticateToken, requireRole(['driver', 'admin']), async (req: AuthenticatedRequest, res: Response) => {
  const { tripId, busId, reason } = req.body;
  if (!tripId || !busId || !reason) return res.status(400).json({ error: 'Missing parameters.' });

  try {
    await db.collection('trips').doc(tripId).update({ status: 'breakdown' });
    await db.collection('buses').doc(busId).update({ status: 'maintenance' });

    // Send broadcast warning alert
    const tripSnap = await db.collection('trips').doc(tripId).get();
    const routeId = tripSnap.exists ? tripSnap.data()?.routeId : null;
    const busSnap = await db.collection('buses').doc(busId).get();
    const busNum = busSnap.exists ? busSnap.data()?.busNumber : 'KMT';

    const notifId = 'notif_' + Math.random().toString(36).substr(2, 9);
    await db.collection('notifications').doc(notifId).set({
      notificationId: notifId,
      title: 'SERVICE INTERRUPTION: Vehicle Breakdown',
      body: `Bus ${busNum} has encountered a mechanical breakdown. Expect delays. Reason: ${reason}`,
      type: 'delay',
      routeId,
      timestamp: Date.now()
    });

    return res.status(200).json({ success: true });
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
