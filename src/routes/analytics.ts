import { Router, Response } from 'express';
import { AuthenticatedRequest, authenticateToken, requireRole } from '../middleware/auth';
import { db } from '../services/db';
import { Workbook } from 'exceljs';

const router = Router();

/**
 * REST endpoint rendering consolidated analytics figures for Web Operations Dashboard.
 */
router.get('/dashboard', authenticateToken, requireRole(['admin']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ticketsSnap = await db.collection('tickets').get();
    const passesSnap = await db.collection('passes').get();
    const busesSnap = await db.collection('buses').get();
    const tripsSnap = await db.collection('trips').get();
    const sosSnap = await db.collection('emergencyRequests').get();

    const totalTickets = ticketsSnap.size;
    const totalPasses = passesSnap.size;
    
    let ticketRevenue = 0;
    ticketsSnap.forEach(doc => {
      const d = doc.data();
      if (d.paymentStatus === 'paid') {
        ticketRevenue += d.fare || 0;
      }
    });

    let passRevenue = 0;
    passesSnap.forEach(doc => {
      const d = doc.data();
      if (d.paymentStatus === 'paid') {
        let price = 250;
        if (d.type === 'monthly') price = 500;
        if (d.type === 'senior') price = 150;
        passRevenue += price;
      }
    });

    const activeFleet = busesSnap.docs.filter(b => b.data().status === 'active').length;
    const pendingSos = sosSnap.docs.filter(s => s.data().status === 'pending').length;

    res.status(200).json({
      success: true,
      stats: {
        totalTickets,
        totalPasses,
        ticketRevenue,
        passRevenue,
        totalRevenue: ticketRevenue + passRevenue,
        activeFleet,
        maintenanceFleet: busesSnap.size - activeFleet,
        activeTrips: tripsSnap.docs.filter(t => t.data().status === 'active').length,
        pendingSos
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Downloads compiled CSV or Excel files aggregating revenue audits or ridership logs.
 */
router.get('/export', authenticateToken, requireRole(['admin']), async (req: AuthenticatedRequest, res: Response) => {
  const { format, reportType } = req.query; // format = csv | excel, reportType = revenue | ridership

  try {
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('Analytics Report');

    if (reportType === 'revenue') {
      sheet.columns = [
        { header: 'Transaction ID', key: 'id', width: 20 },
        { header: 'Payer Name', key: 'name', width: 25 },
        { header: 'Amount (₹)', key: 'amount', width: 15 },
        { header: 'Payment Method', key: 'method', width: 15 },
        { header: 'Status', key: 'status', width: 15 },
        { header: 'Date', key: 'date', width: 25 },
      ];

      const txSnap = await db.collection('transactions').get();
      txSnap.forEach(doc => {
        const d = doc.data();
        sheet.addRow({
          id: d.transactionId || doc.id,
          name: d.payerName || 'Anonymous',
          amount: d.amount || 0,
          method: d.paymentMethod || 'N/A',
          status: d.status || 'N/A',
          date: new Date(d.timestamp).toLocaleString(),
        });
      });
    } else {
      sheet.columns = [
        { header: 'Ticket ID', key: 'id', width: 20 },
        { header: 'Passenger ID', key: 'passengerId', width: 20 },
        { header: 'Route ID', key: 'route', width: 15 },
        { header: 'Source Stop', key: 'source', width: 20 },
        { header: 'Destination Stop', key: 'dest', width: 20 },
        { header: 'Fare (₹)', key: 'fare', width: 15 },
        { header: 'Status', key: 'status', width: 15 },
        { header: 'Timestamp', key: 'time', width: 25 },
      ];

      const ticketsSnap = await db.collection('tickets').get();
      for (const doc of ticketsSnap.docs) {
        const d = doc.data();
        sheet.addRow({
          id: d.ticketId || doc.id,
          passengerId: d.passengerId || 'N/A',
          route: d.routeId || 'N/A',
          source: d.sourceStop || 'N/A',
          dest: d.destinationStop || 'N/A',
          fare: d.fare || 0,
          status: d.status || 'N/A',
          time: new Date(d.timestamp).toLocaleString(),
        });
      }
    }

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=kmt_${reportType || 'ridership'}_report.csv`);
      const csv = await workbook.csv.writeBuffer();
      return res.send(csv);
    } else {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=kmt_${reportType || 'ridership'}_report.xlsx`);
      const buffer = await workbook.xlsx.writeBuffer();
      return res.send(buffer);
    }
  } catch (error: any) {
    res.status(500).send(`Failed to generate report: ${error.message}`);
  }
});

export default router;
