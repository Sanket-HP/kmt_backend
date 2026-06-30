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

export default router;
