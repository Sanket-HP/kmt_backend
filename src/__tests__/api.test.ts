import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.testing' });

const mockGet = jest.fn();
const mockSet = jest.fn().mockResolvedValue({});
const mockUpdate = jest.fn().mockResolvedValue({});

jest.mock('firebase-admin', () => {
  const collectionMock = jest.fn(() => ({
    doc: jest.fn(() => ({
      get: mockGet,
      set: mockSet,
      update: mockUpdate
    })),
    where: jest.fn(() => ({
      get: jest.fn().mockResolvedValue({
        size: 1,
        docs: [
          {
            id: 'test_doc',
            data: () => ({ transactionId: 'pay_mock123', status: 'success', amount: 500 })
          }
        ]
      })
    })),
    get: jest.fn().mockResolvedValue({
      size: 2,
      docs: [
        { id: '1', data: () => ({ status: 'active', fare: 20, paymentStatus: 'paid' }) },
        { id: '2', data: () => ({ status: 'pending', fare: 15, paymentStatus: 'paid' }) }
      ]
    })
  }));

  const firestoreMock = jest.fn(() => ({
    collection: collectionMock
  })) as any;
  
  firestoreMock.FieldValue = {
    arrayUnion: jest.fn((val) => [val])
  };

  return {
    initializeApp: jest.fn(),
    apps: [],
    credential: {
      cert: jest.fn()
    },
    firestore: Object.assign(() => firestoreMock(), { FieldValue: firestoreMock.FieldValue }),
    auth: () => ({
      verifyIdToken: jest.fn().mockResolvedValue({ uid: 'mock_user_uid', email: 'test@kmt.gov.in' })
    })
  };
});

import request from 'supertest';
import express from 'express';
import cors from 'cors';
import paymentsRouter from '../routes/payments';
import fleetRouter from '../routes/fleet';
import analyticsRouter from '../routes/analytics';
import supportRouter from '../routes/support';

const app = express();
app.use(express.json());
app.use('/payments', paymentsRouter);
app.use('/fleet', fleetRouter);
app.use('/analytics', analyticsRouter);
app.use('/support', supportRouter);

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'UP' });
});

describe('KMT Backend REST API Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /health', () => {
    it('should return UP status', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('UP');
    });
  });

  describe('Fleet Operations Route Guards & Dispatch', () => {
    it('should block /fleet/dispatch without auth token', async () => {
      const res = await request(app)
        .post('/fleet/dispatch')
        .send({ busId: 'bus_1', routeId: 'route_1', driverId: 'd_1', conductorId: 'c_1' });
      expect(res.status).toBe(401);
    });

    it('should block non-admin users from dispatching', async () => {
      mockGet.mockResolvedValueOnce({
        exists: true,
        data: () => ({ role: 'passenger', name: 'John Doe' }) // mock user role lookup
      });

      const res = await request(app)
        .post('/fleet/dispatch')
        .set('Authorization', 'Bearer mock-token')
        .send({ busId: 'bus_1', routeId: 'route_1', driverId: 'd_1', conductorId: 'c_1' });
      
      expect(res.status).toBe(403);
    });

    it('should complete dispatch if user is admin and assets exist', async () => {
      // 1. User profile read -> admin
      mockGet.mockResolvedValueOnce({
        exists: true,
        data: () => ({ role: 'admin', name: 'Admin User' })
      });
      // 2. Driver role verification -> driver
      mockGet.mockResolvedValueOnce({
        exists: true,
        data: () => ({ role: 'driver', phone: '9999999999' })
      });
      // 3. Conductor role verification -> conductor
      mockGet.mockResolvedValueOnce({
        exists: true,
        data: () => ({ role: 'conductor', phone: '8888888888' })
      });
      // 4. Bus verification -> active
      mockGet.mockResolvedValueOnce({
        exists: true,
        data: () => ({ status: 'active', busNumber: 'MH-09-1234' })
      });

      const res = await request(app)
        .post('/fleet/dispatch')
        .set('Authorization', 'Bearer mock-token')
        .send({
          busId: 'bus_1',
          routeId: 'route_1',
          driverId: 'driver_uid',
          conductorId: 'conductor_uid',
          timetableTime: '10:00'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.trip.status).toBe('scheduled');
      expect(mockSet).toHaveBeenCalled();
    });
  });

  describe('Payment Signatures Verification', () => {
    it('should reject payment verification if parameters are missing', async () => {
      mockGet.mockResolvedValueOnce({
        exists: true,
        data: () => ({ role: 'passenger' })
      });

      const res = await request(app)
        .post('/payments/verify')
        .set('Authorization', 'Bearer mock-token')
        .send({ orderId: 'ord_123' }); // missing other fields

      expect(res.status).toBe(400);
    });

    it('should verify payment and update ticket details upon valid signature', async () => {
      // 1. User role check
      mockGet.mockResolvedValueOnce({
        exists: true,
        data: () => ({ role: 'passenger' })
      });
      // 2. Transaction replay check (mock as not existing)
      mockGet.mockResolvedValueOnce({
        exists: false
      });
      // 3. Ticket status lookup mock
      mockGet.mockResolvedValueOnce({
        exists: true,
        data: () => ({ status: 'pending', paymentStatus: 'pending' })
      });

      const orderId = 'order_123';
      const paymentId = 'pay_123';
      const secret = process.env.RAZORPAY_KEY_SECRET || 'testing_razorpay_secret_key_here';
      const crypto = require('crypto');
      const validSig = crypto
        .createHmac('sha256', secret)
        .update(orderId + '|' + paymentId)
        .digest('hex');

      const res = await request(app)
        .post('/payments/verify')
        .set('Authorization', 'Bearer mock-token')
        .send({
          orderId,
          paymentId,
          signature: validSig,
          amount: 500,
          paymentMethod: 'upi',
          payerDetails: { name: 'Payer', phone: '123', email: 'a@b.com' },
          itemId: 'ticket_abc',
          itemType: 'ticket',
          billingDetails: { name: 'Billed Name', phone: '123' }
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.invoice.invoiceId).toBeDefined();
    });
  });

  describe('Support Complaints & Feedback Logging', () => {
    it('should submit complaints for passengers', async () => {
      mockGet.mockResolvedValueOnce({
        exists: true,
        data: () => ({ role: 'passenger', name: 'Passenger User' })
      });

      const res = await request(app)
        .post('/support/complaint')
        .set('Authorization', 'Bearer mock-token')
        .send({
          category: 'driver',
          subject: 'Speeding bus',
          description: 'Bus MH-09-1234 was speeding near CBS.'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.complaint.status).toBe('pending');
    });

    it('should allow admins to update complaint ticket status', async () => {
      mockGet.mockResolvedValueOnce({
        exists: true,
        data: () => ({ role: 'admin' })
      });
      mockGet.mockResolvedValueOnce({
        exists: true,
        data: () => ({ status: 'pending' })
      });

      const res = await request(app)
        .post('/support/complaint/status')
        .set('Authorization', 'Bearer mock-token')
        .send({
          complaintId: 'comp_123',
          status: 'resolved',
          note: 'Addressed concerns with the operations team.'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockUpdate).toHaveBeenCalled();
    });
  });
});
