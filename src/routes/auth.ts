import { Router, Request, Response } from 'express';
import { db, auth } from '../services/db';
import { verifyPassword } from '../services/hash';

const router = Router();

/**
 * POST /api/auth/employee-login
 * Authenticates Driver/Conductor by Employee ID and password.
 * Returns a Firebase Custom Token for client login.
 */
router.post('/employee-login', async (req: Request, res: Response) => {
  const { employeeId, password } = req.body;

  if (!employeeId || !password) {
    return res.status(400).json({ error: 'Employee ID and password are required.' });
  }

  try {
    // 1. Search for user by employeeId
    const userQuery = await db.collection('users')
      .where('employeeId', '==', employeeId.trim())
      .limit(1)
      .get();

    if (userQuery.empty) {
      return res.status(401).json({ error: 'Invalid Employee ID or credentials.' });
    }

    const userDoc = userQuery.docs[0];
    const userData = userDoc.data();
    const uid = userDoc.id;

    if (userData.status === 'inactive') {
      return res.status(403).json({ error: 'This employee account is deactivated. Contact Administrator.' });
    }

    // 2. Fetch the password hash from secure secrets collection
    const secretDoc = await db.collection('employeeSecrets').doc(uid).get();
    if (!secretDoc.exists) {
      return res.status(401).json({ error: 'Invalid credentials setup.' });
    }

    const { passwordHash } = secretDoc.data()!;

    // 3. Verify the password
    const isPasswordCorrect = verifyPassword(password, passwordHash);
    if (!isPasswordCorrect) {
      return res.status(401).json({ error: 'Invalid Employee ID or credentials.' });
    }

    // 4. Generate custom token
    const customToken = await auth.createCustomToken(uid, {
      role: userData.role,
      employeeId: userData.employeeId
    });

    console.log(`[Auth Router] Employee logged in: ${employeeId} (${userData.role})`);

    return res.status(200).json({
      success: true,
      customToken,
      user: {
        uid,
        employeeId: userData.employeeId,
        name: userData.name,
        role: userData.role,
        phone: userData.phone || '',
        email: userData.email || ''
      }
    });
  } catch (error: any) {
    console.error('[Auth Router] Login error:', error);
    return res.status(500).json({ error: error.message || 'Internal login error.' });
  }
});

/**
 * POST /api/auth/verify-admin
 * Verifies a Firebase ID token, checks if user has "admin" role in Firestore.
 */
router.post('/verify-admin', async (req: Request, res: Response) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token is missing.' });
  }

  try {
    const decodedToken = await auth.verifyIdToken(token);
    const userDoc = await db.collection('users').doc(decodedToken.uid).get();

    if (!userDoc.exists) {
      return res.status(403).json({ error: 'Unauthorized Access. User profile not found.' });
    }

    const userData = userDoc.data();
    if (userData?.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized Access. Administrative privileges required.' });
    }

    if (!userData.isActive) {
      return res.status(403).json({ error: 'Unauthorized Access. This account is deactivated.' });
    }

    return res.status(200).json({
      success: true,
      user: {
        uid: decodedToken.uid,
        email: decodedToken.email,
        name: userData.name,
        role: userData.role,
        employeeId: userData.employeeId,
        requirePasswordChange: !!userData.requirePasswordChange
      }
    });
  } catch (err: any) {
    console.error('[Verify Admin Endpoint Error]:', err);
    return res.status(401).json({ error: 'Invalid token or session expired.' });
  }
});

/**
 * POST /api/auth/change-admin-password
 * Authenticates the admin and updates their password, disabling further bootstrapping.
 */
router.post('/change-admin-password', async (req: Request, res: Response) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  const { newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ error: 'Token and new password are required.' });
  }

  try {
    const decodedToken = await auth.verifyIdToken(token);
    const uid = decodedToken.uid;

    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists || userDoc.data()?.role !== 'admin') {
      return res.status(403).json({ error: 'Access Denied.' });
    }

    // Update Firebase Auth password
    await auth.updateUser(uid, { password: newPassword });

    // Update Firestore admin document to set requirePasswordChange = false
    await db.collection('users').doc(uid).update({
      requirePasswordChange: false,
      updatedAt: Date.now()
    });

    console.log(`[Bootstrap] Admin password successfully changed. Initialization disabled for uid: ${uid}`);

    return res.status(200).json({ success: true, message: 'Password updated successfully.' });
  } catch (err: any) {
    console.error('[Change Admin Password Endpoint Error]:', err);
    return res.status(500).json({ error: err.message || 'Internal server error changing password.' });
  }
});

export default router;
