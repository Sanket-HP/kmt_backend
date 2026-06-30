import { Router, Response } from 'express';
import { AuthenticatedRequest, authenticateToken, requireRole } from '../middleware/auth';
import { db, FieldValue } from '../services/db';

const router = Router();

/**
 * Creates support ticket complains from passengers.
 */
router.post('/complaint', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  const { category, subject, description } = req.body;

  if (!category || !subject || !description) {
    return res.status(400).json({ error: 'Missing required parameters.' });
  }

  try {
    const complaintId = 'comp_' + Math.random().toString(36).substr(2, 9);
    const complaint = {
      complaintId,
      userId: req.user?.uid || 'anonymous',
      userName: req.user?.name || 'Anonymous',
      category,
      subject,
      description,
      status: 'pending',
      timestamp: Date.now(),
      updates: []
    };

    await db.collection('complaints').doc(complaintId).set(complaint);
    return res.status(200).json({ success: true, complaint });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Lists complaints (admins read all, passengers read only their own).
 */
router.get('/complaints', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    let querySnap;
    if (req.user?.role === 'admin') {
      querySnap = await db.collection('complaints').get();
    } else {
      querySnap = await db.collection('complaints').where('userId', '==', req.user?.uid).get();
    }

    const complaints = querySnap.docs.map(doc => doc.data());
    return res.status(200).json({ success: true, complaints });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Updates complaint ticket status (e.g. pending -> investigated -> resolved).
 */
router.post('/complaint/status', authenticateToken, requireRole(['admin']), async (req: AuthenticatedRequest, res: Response) => {
  const { complaintId, status, note } = req.body;

  if (!complaintId || !status) {
    return res.status(400).json({ error: 'Missing complaintId or status parameters.' });
  }

  try {
    const ref = db.collection('complaints').doc(complaintId);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Complaint ticket not found.' });
    }

    const update = {
      status,
      updates: FieldValue.arrayUnion({
        status,
        note: note || '',
        timestamp: Date.now()
      })
    };
    await ref.update(update);

    return res.status(200).json({ success: true, message: 'Support ticket status updated.' });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Registers Lost & Found items (Admin role only).
 */
router.post('/lostfound', authenticateToken, requireRole(['admin']), async (req: AuthenticatedRequest, res: Response) => {
  const { itemName, description, dateFound, locationFound, status } = req.body;

  if (!itemName || !description || !locationFound) {
    return res.status(400).json({ error: 'Missing item details.' });
  }

  try {
    const itemId = 'lf_' + Math.random().toString(36).substr(2, 9);
    const item = {
      itemId,
      itemName,
      description,
      dateFound: dateFound || new Date().toISOString().split('T')[0],
      locationFound,
      status: status || 'unclaimed',
      timestamp: Date.now()
    };

    await db.collection('lostfound').doc(itemId).set(item);
    return res.status(200).json({ success: true, item });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Retrieves Lost & Found logs.
 */
router.get('/lostfound', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const snap = await db.collection('lostfound').get();
    const items = snap.docs.map(doc => doc.data());
    return res.status(200).json({ success: true, items });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/support/feedback
 * Registers user feedback for drivers/buses.
 */
router.post('/feedback', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  const { ratingDriver, ratingBus, issue, feedbackText } = req.body;

  if (ratingDriver === undefined || ratingBus === undefined || !issue || !feedbackText) {
    return res.status(400).json({ error: 'Missing ratingDriver, ratingBus, issue, or feedbackText.' });
  }

  const feedbackId = 'fb_' + Math.random().toString(36).substr(2, 9);
  const feedback = {
    feedbackId,
    userId: req.user?.uid || 'guest',
    ratingDriver: parseInt(ratingDriver),
    ratingBus: parseInt(ratingBus),
    issue,
    feedbackText,
    timestamp: Date.now()
  };

  try {
    await db.collection('feedback').doc(feedbackId).set(feedback);
    return res.status(201).json({ success: true, feedback });
  } catch (error: any) {
    console.error('[Support Router] Feedback failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to submit feedback.' });
  }
});

/**
 * POST /api/support/sos
 * Renders active passenger/driver SOS request.
 */
router.post('/sos', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  const { latitude, longitude } = req.body;

  if (latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: 'Latitude and Longitude are required for SOS.' });
  }

  const sosId = 'sos_' + Math.random().toString(36).substr(2, 9);
  const sos = {
    sosId,
    userId: req.user?.uid || 'guest',
    latitude: parseFloat(latitude),
    longitude: parseFloat(longitude),
    timestamp: Date.now(),
    status: 'pending'
  };

  try {
    await db.collection('emergencyRequests').doc(sosId).set(sos);

    // Auto-schedule system notification for emergencies
    const systemNotifId = 'notif_' + Math.random().toString(36).substr(2, 9);
    await db.collection('notifications').doc(systemNotifId).set({
      id: systemNotifId,
      title: 'EMERGENCY SOS ALERT',
      message: `Emergency location triggered by KMT User at coordinates: ${latitude}, ${longitude}`,
      type: 'emergency',
      timestamp: Date.now()
    });

    return res.status(201).json({ success: true, sos });
  } catch (error: any) {
    console.error('[Support Router] SOS trigger failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to trigger SOS.' });
  }
});

/**
 * POST /api/support/sos/resolve
 * Resolves active emergency SOS.
 */
router.post('/sos/resolve', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  const { sosId } = req.body;

  if (!sosId) {
    return res.status(400).json({ error: 'sosId is required.' });
  }

  try {
    await db.collection('emergencyRequests').doc(sosId).update({ status: 'resolved' });
    return res.status(200).json({ success: true, message: 'SOS alert resolved.' });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to resolve SOS.' });
  }
});

export default router;
