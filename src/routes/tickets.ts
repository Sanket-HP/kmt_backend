import { Router, Response } from 'express';
import { AuthenticatedRequest, authenticateToken } from '../middleware/auth';
import { db } from '../services/db';

const router = Router();

// Require auth for all ticket/pass creations
router.use(authenticateToken);

/**
 * POST /api/tickets/book
 * Creates a ticket in Firestore. Replaces direct client-side write.
 */
router.post('/book', async (req: AuthenticatedRequest, res: Response) => {
  const { routeId, sourceStop, destinationStop, fare } = req.body;

  if (!routeId || !sourceStop || !destinationStop || fare === undefined) {
    return res.status(400).json({ error: 'Missing routeId, sourceStop, destinationStop, or fare.' });
  }

  const ticketId = 'tkt_' + Math.random().toString(36).substr(2, 9);
  
  const ticket = {
    ticketId,
    passengerId: req.user?.uid || 'guest',
    passengerName: req.user?.name || 'Passenger',
    routeId,
    sourceStop,
    destinationStop,
    fare: parseFloat(fare),
    status: 'purchased',
    timestamp: Date.now(),
    scannedAt: null,
    paymentStatus: 'pending',
    transactionId: ''
  };

  try {
    await db.collection('tickets').doc(ticketId).set(ticket);
    return res.status(201).json({ success: true, ticket });
  } catch (error: any) {
    console.error('[Tickets Router] Book ticket failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to book ticket.' });
  }
});

/**
 * POST /api/passes/purchase
 * Creates a bus pass in Firestore. Replaces direct client-side write.
 */
router.post('/purchase', async (req: AuthenticatedRequest, res: Response) => {
  const { type, expiryMonths } = req.body;

  if (!type || !expiryMonths) {
    return res.status(400).json({ error: 'Missing type or expiryMonths parameters.' });
  }

  const passId = 'pass_' + Math.random().toString(36).substr(2, 9);
  
  const expiry = new Date();
  expiry.setMonth(expiry.getMonth() + parseInt(expiryMonths));

  const pass = {
    passId,
    passengerId: req.user?.uid || 'guest',
    passengerName: req.user?.name || 'Passenger',
    type,
    status: 'expired', // Activated upon payment success verify
    expiryDate: expiry.toLocaleDateString(),
    createdAt: new Date().toLocaleDateString(),
    paymentStatus: 'pending',
    transactionId: ''
  };

  try {
    await db.collection('passes').doc(passId).set(pass);
    return res.status(201).json({ success: true, pass });
  } catch (error: any) {
    console.error('[Tickets Router] Purchase pass failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to purchase pass.' });
  }
});

export default router;
