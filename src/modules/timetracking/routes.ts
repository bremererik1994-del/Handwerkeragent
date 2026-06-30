import { Router } from 'express';
import prisma from '../../db';
import { requireRole } from '../../middleware/roleGuard';

const router = Router();

// GET /api/time-entries?employeeId=&from=&to=&companyId=
router.get('/', requireRole(['INHABER', 'STANDORTLEITER']), async (req, res) => {
  try {
    const { employeeId, from, to } = req.query as Record<string, string>;
    const companyId = (req as any).user.companyId as string;

    const entries = await prisma.timeEntry.findMany({
      where: {
        companyId,
        ...(employeeId && { employeeId }),
        ...(from && { startTime: { gte: new Date(from) } }),
        ...(to && { endTime: { lte: new Date(to) } }),
      },
      include: {
        employee: { select: { id: true, name: true, phone: true } },
        location: { select: { id: true, name: true } },
        auditLogs: true,
      },
      orderBy: { startTime: 'desc' },
    });

    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der Zeiteinträge' });
  }
});

// GET /api/time-entries/my – employee's own entries
router.get('/my', async (req, res) => {
  try {
    const employeeId = (req as any).user.employeeId as string;
    const { from, to } = req.query as Record<string, string>;

    const entries = await prisma.timeEntry.findMany({
      where: {
        employeeId,
        ...(from && { startTime: { gte: new Date(from) } }),
        ...(to && { endTime: { lte: new Date(to) } }),
      },
      include: { location: { select: { id: true, name: true } } },
      orderBy: { startTime: 'desc' },
    });

    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// PATCH /api/time-entries/:id – supervisor correction
router.patch('/:id', requireRole(['INHABER']), async (req, res) => {
  try {
    const { id } = req.params;
    const userId = (req as any).user.employeeId as string;
    const { startTime, endTime, breakMinutes, reason } = req.body;

    const old = await prisma.timeEntry.findUniqueOrThrow({ where: { id } });

    const updated = await prisma.timeEntry.update({
      where: { id },
      data: {
        ...(startTime && { startTime: new Date(startTime) }),
        ...(endTime && { endTime: new Date(endTime) }),
        ...(breakMinutes !== undefined && { breakMinutes }),
        status: 'CORRECTED',
      },
    });

    // Recalculate totalMinutes
    if (updated.endTime) {
      const { differenceInMinutes } = await import('date-fns');
      const gross = differenceInMinutes(updated.endTime, updated.startTime);
      await prisma.timeEntry.update({
        where: { id },
        data: { totalMinutes: Math.max(0, gross - (updated.breakMinutes ?? 0)) },
      });
    }

    await prisma.timeEntryAudit.create({
      data: {
        entryId: id,
        changedBy: userId,
        changeType: 'CORRECT',
        oldValue: old as unknown as Record<string, unknown>,
        newValue: updated as unknown as Record<string, unknown>,
        reason,
      },
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Korrektur fehlgeschlagen' });
  }
});

export default router;
