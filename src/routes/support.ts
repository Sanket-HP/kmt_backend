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

export default router;
