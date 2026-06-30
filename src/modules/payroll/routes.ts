import { Router } from 'express';
import { generatePayrollSummary } from './service';
import { exportDatevCsv, exportLexwareCsv, exportXlsx, streamPayrollPdf } from '../export/datev';
import { requireRole } from '../../middleware/roleGuard';
import prisma from '../../db';

const router = Router();

// GET /api/payroll/summary?employeeId=&from=&to=
router.get('/summary', requireRole(['INHABER']), async (req, res) => {
  try {
    const { employeeId, from, to } = req.query as Record<string, string>;
    const companyId = (req as any).user.companyId as string;

    const fromDate = from ? new Date(from) : (() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; })();
    const toDate = to ? new Date(to) : new Date();

    let employeeIds: string[];
    if (employeeId) {
      employeeIds = [employeeId];
    } else {
      const emps = await prisma.employee.findMany({
        where: { companyId, deletedAt: null },
        select: { id: true },
      });
      employeeIds = emps.map((e) => e.id);
    }

    const summaries = await Promise.all(
      employeeIds.map((eid) => generatePayrollSummary(companyId, eid, fromDate, toDate)),
    );

    res.json(summaries);
  } catch (err) {
    res.status(500).json({ error: 'Fehler bei Lohnvorbereitung' });
  }
});

// GET /api/payroll/export/datev-csv
router.get('/export/datev-csv', requireRole(['INHABER']), async (req, res) => {
  try {
    const { from, to } = req.query as Record<string, string>;
    const companyId = (req as any).user.companyId as string;
    const fromDate = from ? new Date(from) : (() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; })();
    const toDate = to ? new Date(to) : new Date();

    const emps = await prisma.employee.findMany({ where: { companyId, deletedAt: null }, select: { id: true } });
    const summaries = await Promise.all(
      emps.map((e) => generatePayrollSummary(companyId, e.id, fromDate, toDate)),
    );

    const csv = exportDatevCsv(summaries);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="datev_lohnvorbereitung.csv"');
    res.send('﻿' + csv); // BOM for Excel
  } catch (err) {
    res.status(500).json({ error: 'Export fehlgeschlagen' });
  }
});

// GET /api/payroll/export/xlsx
router.get('/export/xlsx', requireRole(['INHABER']), async (req, res) => {
  try {
    const { from, to } = req.query as Record<string, string>;
    const companyId = (req as any).user.companyId as string;
    const fromDate = from ? new Date(from) : (() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; })();
    const toDate = to ? new Date(to) : new Date();

    const emps = await prisma.employee.findMany({ where: { companyId, deletedAt: null }, select: { id: true } });
    const summaries = await Promise.all(
      emps.map((e) => generatePayrollSummary(companyId, e.id, fromDate, toDate)),
    );

    const buffer = exportXlsx(summaries);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="lohnvorbereitung.xlsx"');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'Export fehlgeschlagen' });
  }
});

// GET /api/payroll/export/lexware-csv
router.get('/export/lexware-csv', requireRole(['INHABER']), async (req, res) => {
  try {
    const { from, to } = req.query as Record<string, string>;
    const companyId = (req as any).user.companyId as string;
    const fromDate = from ? new Date(from) : (() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; })();
    const toDate = to ? new Date(to) : new Date();

    const emps = await prisma.employee.findMany({ where: { companyId, deletedAt: null }, select: { id: true } });
    const summaries = await Promise.all(
      emps.map((e) => generatePayrollSummary(companyId, e.id, fromDate, toDate)),
    );

    const csv = exportLexwareCsv(summaries);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="lexware_lohnarten.csv"');
    res.send('﻿' + csv); // BOM für Excel
  } catch {
    res.status(500).json({ error: 'Lexware-Export fehlgeschlagen' });
  }
});

// GET /api/payroll/export/pdf?employeeId=
router.get('/export/pdf', requireRole(['INHABER']), async (req, res) => {
  try {
    const { employeeId, from, to } = req.query as Record<string, string>;
    const companyId = (req as any).user.companyId as string;
    const fromDate = from ? new Date(from) : (() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; })();
    const toDate = to ? new Date(to) : new Date();

    if (!employeeId) { res.status(400).json({ error: 'employeeId erforderlich' }); return; }

    const summary = await generatePayrollSummary(companyId, employeeId, fromDate, toDate);
    streamPayrollPdf(summary, res);
  } catch (err) {
    res.status(500).json({ error: 'PDF-Export fehlgeschlagen' });
  }
});

export default router;
