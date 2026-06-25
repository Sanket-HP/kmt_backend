import { Request, Response, NextFunction } from 'express';
import { auth, db } from '../services/db';

export interface AuthenticatedRequest extends Request {
  user?: {
    uid: string;
    email?: string;
    role?: 'passenger' | 'driver' | 'conductor' | 'admin';
    name?: string;
  };
}

/**
 * Express middleware to authenticate Firebase ID Tokens and fetch user profile roles from Firestore.
 */
export const authenticateToken = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];

  if (!token && req.query.token) {
    token = req.query.token as string;
  }

  if (!token) {
    return res.status(401).json({ error: 'Authorization header or query token is missing.' });
  }

  try {
    // 1. Verify token against Firebase Authentication
    const decodedToken = await auth.verifyIdToken(token);
    
    // 2. Fetch role and profile details from Firestore /users/{uid}
    const userDoc = await db.collection('users').doc(decodedToken.uid).get();
    const userData = userDoc.exists ? userDoc.data() : null;
    const role = userData?.role || 'passenger';

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      name: userData?.name || decodedToken.name,
      role
    };

    next();
  } catch (error: any) {
    console.error('[Auth Middleware] Token verification failed:', error.message || error);
    return res.status(403).json({ error: 'Invalid or expired authorization token.' });
  }
};

/**
 * Express middleware role guard.
 */
export const requireRole = (allowedRoles: Array<'passenger' | 'driver' | 'conductor' | 'admin'>) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'User is not authenticated.' });
    }

    if (!allowedRoles.includes(req.user.role as any)) {
      return res.status(403).json({ error: `Access denied. Role ${req.user.role?.toUpperCase()} is unauthorized.` });
    }

    next();
  };
};
