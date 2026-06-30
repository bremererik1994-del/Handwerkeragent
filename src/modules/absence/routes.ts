import { Router } from 'express';
import prisma from '../../db';
import { requireRole } from '../../middleware/roleGuard';

const router = Router();

// GET /api/absences — list absences for the company (filterable by employee, month, type)
router.get('/', async (req, res) => {
  try {
    const companyId = (req as any).user.companyId as string;
    const { employeeId, type, from, to } = req.query as Record<string, string | undefined>;

    const absences = await prisma.absence.findMany({
      where: {
        companyId,
        deletedAt: null,
        ...(employeeId && { employeeId }),
        ...(type && { type: type as any }),
        ...(from && { startDate: { gte: new Date(from) } }),
        ...(to && { endDate: { lte: new Date(to) } }),
      },
      include: {
        employee: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { startDate: 'desc' },
    });

    res.json(absences);
  } catch {
    res.status(500).json({ error: 'Fehler' });
  }
});

// GET /api/absences/:id
router.get('/:id', async (req, res) => {
  try {
    const companyId = (req as any).user.companyId as string;
    const absence = await prisma.absence.findFirst({
      where: { id: req.params.id, companyId, deletedAt: null },
      include: { employee: { select: { id: true, name: true } } },
    });
    if (!absence) { res.status(404).json({ error: 'Nicht gefunden' }); return; }
    res.json(absence);
  } catch {
    res.status(500).json({ error: 'Fehler' });
  }
});

// PATCH /api/absences/:id/status — Inhaber confirms or rejects (URLAUB / ZEITAUSGLEICH)
router.patch('/:id/status', requireRole(['INHABER', 'STANDORTLEITER']), async (req, res) => {
  try {
    const companyId = (req as any).user.companyId as string;
    const { status, note } = req.body as { status: 'BESTAETIGT' | 'ABGELEHNT'; note?: string };

    const absence = await prisma.absence.updateMany({
      where: { id: req.params.id, companyId, deletedAt: null },
      data: { status, ...(note && { note }) },
    });

    res.json({ ok: true, updated: absence.count });
  } catch {
    res.status(500).json({ error: 'Fehler' });
  }
});

// DELETE /api/absences/:id — soft-delete
router.delete('/:id', requireRole(['INHABER']), async (req, res) => {
  try {
    const companyId = (req as any).user.companyId as string;
    await prisma.absence.updateMany({
      where: { id: req.params.id, companyId },
      data: { deletedAt: new Date() },
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Fehler' });
  }
});

export default router;
