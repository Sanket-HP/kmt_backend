import { Router, Response } from 'express';
import { AuthenticatedRequest, authenticateToken, requireRole } from '../middleware/auth';
import { db } from '../services/db';
import crypto from 'crypto';

const router = Router();

/**
 * Unauthenticated webhook callback endpoint receiving event triggers from Razorpay.
 */
router.post('/webhook', async (req, res) => {
  console.log('[Razorpay Webhook] Received payload notification:', req.body);
  const signature = req.headers['x-razorpay-signature'] as string;
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const shasum = crypto.createHmac('sha256', webhookSecret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest('hex');

    if (digest !== signature) {
      console.warn('[Razorpay Webhook] Webhook signature verification failed.');
      return res.status(400).json({ error: 'Invalid webhook signature.' });
    }
  }

  const event = req.body.event;
  if (event === 'payment.captured') {
    const payment = req.body.payload.payment.entity;
    console.log('[Razorpay Webhook] Processed captured payment:', payment.id);
  }
  res.status(200).json({ status: 'ok' });
});

/**
 * Authenticates signature validation and writes invoices/receipt records.
 */
router.post('/verify', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  const { orderId, paymentId, signature, amount, paymentMethod, payerDetails, itemId, itemType, billingDetails } = req.body;

  if (!orderId || !paymentId || !signature || !amount || !payerDetails || !itemId || !itemType || !billingDetails) {
    return res.status(400).json({ error: 'Missing required parameters.' });
  }

  try {
    // 1. Duplicate transaction prevention (Replay protection)
    const transactionRef = db.collection('transactions').doc(paymentId);
    const transactionSnap = await transactionRef.get();
    if (transactionSnap.exists) {
      return res.status(400).json({ error: 'Duplicate payment transaction detected.' });
    }

    // 2. Real cryptographic signature validation
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) {
      return res.status(500).json({ error: 'Razorpay key secret is not configured on the server.' });
    }

    const generatedSignature = crypto
      .createHmac('sha256', secret)
      .update(orderId + "|" + paymentId)
      .digest('hex');

    if (generatedSignature !== signature) {
      return res.status(400).json({ error: 'Payment signature validation failed.' });
    }

    // 2. Write Transaction
    const txData = {
      transactionId: paymentId,
      orderId,
      amount,
      paymentMethod,
      status: 'success',
      timestamp: Date.now(),
      payerName: payerDetails.name,
      payerPhone: payerDetails.phone,
      payerEmail: payerDetails.email,
      userId: req.user?.uid || 'anonymous'
    };
    await transactionRef.set(txData);

    // 3. Calculate GST (CGST 2.5%, SGST 2.5%, reverse math)
    const subTotal = Math.round((amount / 1.05) * 100) / 100;
    const totalGst = Math.round((amount - subTotal) * 100) / 100;
    const cgstAmount = Math.round((totalGst / 2) * 100) / 100;
    const sgstAmount = Math.round((totalGst / 2) * 100) / 100;

    const invoiceId = 'inv_' + Math.random().toString(36).substr(2, 9);
    const invoiceData = {
      invoiceId,
      transactionId: paymentId,
      userId: req.user?.uid || 'anonymous',
      billingName: billingDetails.name,
      billingPhone: billingDetails.phone,
      gstin: billingDetails.gstin || null,
      itemDescription: itemType === 'ticket' ? `KMT QR Ticket booking` : `KMT Digital Transit Pass`,
      subTotal,
      cgstAmount,
      sgstAmount,
      totalAmount: amount,
      timestamp: Date.now()
    };
    await db.collection('invoices').doc(invoiceId).set(invoiceData);

    // 4. Update ticket/pass in Firestore
    const collectionName = itemType === 'ticket' ? 'tickets' : 'passes';
    const itemRef = db.collection(collectionName).doc(itemId);
    const itemSnap = await itemRef.get();
    
    if (itemSnap.exists) {
      await itemRef.update({
        paymentStatus: 'paid',
        transactionId: paymentId,
        status: itemType === 'ticket' ? 'purchased' : 'active'
      });
    }

    return res.status(200).json({ success: true, transaction: txData, invoice: invoiceData });
  } catch (error: any) {
    console.error('[Payment Router] Verification error:', error);
    return res.status(500).json({ error: error.message || 'Internal server verification error.' });
  }
});

/**
 * Triggers administrative payment refund and item deactivation.
 */
router.post('/refund', authenticateToken, requireRole(['admin']), async (req: AuthenticatedRequest, res: Response) => {
  const { transactionId } = req.body;

  if (!transactionId) {
    return res.status(400).json({ error: 'Missing transactionId parameter.' });
  }

  try {
    const txRef = db.collection('transactions').doc(transactionId);
    const txSnap = await txRef.get();
    
    if (!txSnap.exists) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    await txRef.update({ status: 'refunded' });

    const ticketsQuery = await db.collection('tickets').where('transactionId', '==', transactionId).get();
    for (const d of ticketsQuery.docs) {
      await d.ref.update({ paymentStatus: 'failed', status: 'expired' });
    }

    const passesQuery = await db.collection('passes').where('transactionId', '==', transactionId).get();
    for (const d of passesQuery.docs) {
      await d.ref.update({ paymentStatus: 'failed', status: 'expired' });
    }

    return res.status(200).json({ success: true, message: 'Payment refund processed and items deactivated.' });
  } catch (error: any) {
    console.error('[Payment Router] Refund failed:', error);
    return res.status(500).json({ error: error.message || 'Internal server refund processing failure.' });
  }
});

export default router;
