import { Router, Response } from 'express';
import { AuthenticatedRequest, authenticateToken, requireRole } from '../middleware/auth';
import { db, auth } from '../services/db';
import { hashPassword } from '../services/hash';

const router = Router();

// Protect all admin endpoints
router.use(authenticateToken, requireRole(['admin']));

/**
 * ==========================================
 * 1. EMPLOYEE ONBOARDING & MANAGEMENT CRUD
 * ==========================================
 */

/**
 * POST /api/admin/employees/onboard
 * Onboard a new driver or conductor: Creates Firebase Auth account, Firestore profile, and hashes password.
 */
router.post('/employees/onboard', async (req: AuthenticatedRequest, res: Response) => {
  const { employeeId, name, role, phone, password } = req.body;

  if (!employeeId || !name || !role || !password) {
    return res.status(400).json({ error: 'Employee ID, Name, Role, and Password are required.' });
  }

  if (role !== 'driver' && role !== 'conductor') {
    return res.status(400).json({ error: 'Role must be either "driver" or "conductor".' });
  }

  const email = `${employeeId.toLowerCase().trim()}@kmt.gov.in`;

  try {
    // Check if Employee ID already exists in users collection
    const idCheck = await db.collection('users').where('employeeId', '==', employeeId.trim()).limit(1).get();
    if (!idCheck.empty) {
      return res.status(400).json({ error: 'Employee ID is already in use.' });
    }

    // 1. Create Firebase Auth user
    let userRecord;
    try {
      userRecord = await auth.createUser({
        email,
        password,
        displayName: name,
        phoneNumber: phone ? (phone.startsWith('+') ? phone : `+91${phone}`) : undefined
      });
    } catch (authError: any) {
      if (authError.code === 'auth/email-already-in-use') {
        return res.status(400).json({ error: 'Email for this Employee ID is already registered.' });
      }
      if (authError.code === 'auth/phone-number-already-in-use') {
        return res.status(400).json({ error: 'Phone number is already associated with another account.' });
      }
      throw authError;
    }

    const uid = userRecord.uid;

    // Set custom claims for role
    await auth.setCustomUserClaims(uid, { role, employeeId });

    // 2. Save user profile document in Firestore
    await db.collection('users').doc(uid).set({
      uid,
      employeeId: employeeId.trim(),
      name: name.trim(),
      email,
      phone: phone || '',
      role,
      status: 'active',
      createdAt: Date.now()
    });

    // 3. Save secure password hash
    await db.collection('employeeSecrets').doc(uid).set({
      uid,
      employeeId: employeeId.trim(),
      passwordHash: hashPassword(password),
      updatedAt: Date.now()
    });

    console.log(`[Admin] Onboarded new ${role}: ${employeeId} (UID: ${uid})`);

    return res.status(201).json({
      success: true,
      message: `${role.charAt(0).toUpperCase() + role.slice(1)} onboarded successfully.`,
      employee: { uid, employeeId, name, role, email, phone }
    });
  } catch (error: any) {
    console.error('[Admin Router] Onboarding failure:', error);
    return res.status(500).json({ error: error.message || 'Internal server onboarding error.' });
  }
});

/**
 * GET /api/admin/employees
 * Lists all Driver and Conductor employee records.
 */
router.get('/employees', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const usersSnap = await db.collection('users')
      .where('role', 'in', ['driver', 'conductor'])
      .get();

    const list = usersSnap.docs.map(doc => ({ uid: doc.id, ...doc.data() }));
    return res.status(200).json({ success: true, employees: list });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/admin/employees/:uid
 * Update employee details and active status.
 */
router.put('/employees/:uid', async (req: AuthenticatedRequest, res: Response) => {
  const { uid } = req.params;
  const { name, phone, status } = req.body;

  try {
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    const updateData: any = {};
    if (name !== undefined) updateData.name = name.trim();
    if (phone !== undefined) updateData.phone = phone;
    if (status !== undefined) {
      if (status !== 'active' && status !== 'inactive') {
        return res.status(400).json({ error: 'Status must be active or inactive.' });
      }
      updateData.status = status;
      // Disable auth token if deactivated
      await auth.updateUser(uid, { disabled: status === 'inactive' });
    }

    await userRef.update(updateData);
    return res.status(200).json({ success: true, message: 'Employee profile updated.' });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/employees/:uid/reset-password
 * Reset employee password.
 */
router.post('/employees/:uid/reset-password', async (req: AuthenticatedRequest, res: Response) => {
  const { uid } = req.params;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'New password is required.' });
  }

  try {
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    // 1. Update Firebase Auth password
    await auth.updateUser(uid, { password });

    // 2. Update secure password hash
    await db.collection('employeeSecrets').doc(uid).update({
      passwordHash: hashPassword(password),
      updatedAt: Date.now()
    });

    return res.status(200).json({ success: true, message: 'Password reset successfully.' });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/admin/employees/:uid
 * Deletes employee account completely.
 */
router.delete('/employees/:uid', async (req: AuthenticatedRequest, res: Response) => {
  const { uid } = req.params;

  try {
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    // Delete Auth User
    await auth.deleteUser(uid);
    // Delete Firestore profile
    await db.collection('users').doc(uid).delete();
    // Delete secret hash
    await db.collection('employeeSecrets').doc(uid).delete();

    return res.status(200).json({ success: true, message: 'Employee deleted successfully.' });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});


/**
 * ==========================================
 * 2. DUTY ROSTER ASSIGNMENT SYSTEM
 * ==========================================
 */

/**
 * POST /api/admin/duties/assign
 * Assigns a specific bus, route, shift, and date to a Driver and Conductor.
 */
router.post('/duties/assign', async (req: AuthenticatedRequest, res: Response) => {
  const { busId, routeId, driverId, conductorId, shift, date } = req.body;

  if (!busId || !routeId || !driverId || !conductorId || !shift) {
    return res.status(400).json({ error: 'Missing parameters. Bus, Route, Driver, Conductor, and Shift are required.' });
  }

  const targetDate = date || new Date().toISOString().split('T')[0];

  try {
    // Validate driver
    const driverSnap = await db.collection('users').doc(driverId).get();
    if (!driverSnap.exists || driverSnap.data()?.role !== 'driver') {
      return res.status(400).json({ error: 'Invalid driver selection.' });
    }
    const driverName = driverSnap.data()?.name || 'Driver';

    // Validate conductor
    const conductorSnap = await db.collection('users').doc(conductorId).get();
    if (!conductorSnap.exists || conductorSnap.data()?.role !== 'conductor') {
      return res.status(400).json({ error: 'Invalid conductor selection.' });
    }
    const conductorName = conductorSnap.data()?.name || 'Conductor';

    // Validate bus
    const busSnap = await db.collection('buses').doc(busId).get();
    if (!busSnap.exists) {
      return res.status(404).json({ error: 'Bus not found.' });
    }
    if (busSnap.data()?.status === 'maintenance') {
      return res.status(400).json({ error: 'Selected bus is in maintenance.' });
    }
    const busNumber = busSnap.data()?.busNumber || 'Unknown Bus';

    // Validate route
    const routeSnap = await db.collection('routes').doc(routeId).get();
    if (!routeSnap.exists) {
      return res.status(404).json({ error: 'Route not found.' });
    }
    const routeNumber = routeSnap.data()?.routeNumber || 'Unknown Route';

    // Create duty document
    const dutyId = 'duty_' + Math.random().toString(36).substr(2, 9);
    const newDuty = {
      dutyId,
      driverId,
      driverName,
      conductorId,
      conductorName,
      busId,
      busNumber,
      routeId,
      routeNumber,
      shift,
      date: targetDate,
      status: 'assigned',
      tripId: null,
      createdAt: Date.now()
    };

    await db.collection('duties').doc(dutyId).set(newDuty);

    console.log(`[Admin] Assigned duty: Bus ${busNumber}, Route ${routeNumber} to Driver ${driverName}`);

    return res.status(201).json({ success: true, duty: newDuty });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/duties
 * Lists all duty rosters.
 */
router.get('/duties', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const dutiesSnap = await db.collection('duties').orderBy('createdAt', 'desc').get();
    const duties = dutiesSnap.docs.map(doc => doc.data());
    return res.status(200).json({ success: true, duties });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});


/**
 * ==========================================
 * 3. FLEET, ROUTE, AND STOP CRUD ENDPOINTS
 * ==========================================
 */

// BUS CRUD
router.post('/buses', async (req: AuthenticatedRequest, res: Response) => {
  const { busNumber, status } = req.body;
  if (!busNumber) return res.status(400).json({ error: 'busNumber is required.' });

  const busId = 'bus_' + Math.random().toString(36).substr(2, 9);
  try {
    const newBus = { busId, busNumber, status: status || 'active', currentTripId: null, createdAt: Date.now() };
    await db.collection('buses').doc(busId).set(newBus);
    return res.status(201).json({ success: true, bus: newBus });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

router.put('/buses/:id', async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  try {
    await db.collection('buses').doc(id).update(req.body);
    return res.status(200).json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

router.delete('/buses/:id', async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  try {
    await db.collection('buses').doc(id).delete();
    return res.status(200).json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// ROUTE CRUD
router.post('/routes', async (req: AuthenticatedRequest, res: Response) => {
  const { routeNumber, source, destination, fare, stops } = req.body;
  if (!routeNumber || !source || !destination) {
    return res.status(400).json({ error: 'Route number, source, and destination are required.' });
  }

  const routeId = 'route_' + Math.random().toString(36).substr(2, 9);
  try {
    const newRoute = {
      routeId,
      routeNumber,
      source,
      destination,
      fare: parseFloat(fare) || 20,
      stops: stops || [],
      createdAt: Date.now()
    };
    await db.collection('routes').doc(routeId).set(newRoute);
    return res.status(201).json({ success: true, route: newRoute });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

router.put('/routes/:id', async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  try {
    await db.collection('routes').doc(id).update(req.body);
    return res.status(200).json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

router.delete('/routes/:id', async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  try {
    await db.collection('routes').doc(id).delete();
    return res.status(200).json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// STOP CRUD
router.post('/stops', async (req: AuthenticatedRequest, res: Response) => {
  const { name, latitude, longitude } = req.body;
  if (!name || latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: 'Name, latitude, and longitude are required.' });
  }

  const stopId = 'stop_' + Math.random().toString(36).substr(2, 9);
  try {
    const newStop = {
      stopId,
      name,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      createdAt: Date.now()
    };
    await db.collection('stops').doc(stopId).set(newStop);
    return res.status(201).json({ success: true, stop: newStop });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

router.put('/stops/:id', async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  try {
    await db.collection('stops').doc(id).update(req.body);
    return res.status(200).json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

router.delete('/stops/:id', async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  try {
    await db.collection('stops').doc(id).delete();
    return res.status(200).json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

export default router;
