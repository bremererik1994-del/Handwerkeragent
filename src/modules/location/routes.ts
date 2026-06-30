import { Router } from 'express';
import prisma from '../../db';
import { requireRole } from '../../middleware/roleGuard';

const router = Router();

// GET /api/locations
router.get('/', requireRole(['INHABER', 'STANDORTLEITER']), async (req, res) => {
  try {
    const companyId = (req as any).user.companyId as string;

    const locations = await prisma.location.findMany({
      where: { companyId },
      include: {
        assignments: {
          include: { employee: { select: { id: true, name: true, phone: true } } },
        },
        _count: { select: { timeEntries: true, media: true, reports: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Compute actual hours for each location
    const withStats = await Promise.all(
      locations.map(async (loc) => {
        const entries = await prisma.timeEntry.aggregate({
          where: { locationId: loc.id, status: 'COMPLETED' },
          _sum: { totalMinutes: true },
        });
        const actualHours = (entries._sum.totalMinutes ?? 0) / 60;
        return { ...loc, actualHours };
      }),
    );

    res.json(withStats);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// POST /api/locations
router.post('/', requireRole(['INHABER']), async (req, res) => {
  try {
    const companyId = (req as any).user.companyId as string;
    const { name, address, locationType, plannedHours, startDate, endDate, employeeIds } = req.body;

    const location = await prisma.location.create({
      data: {
        companyId,
        name,
        address,
        locationType: locationType ?? 'LADEN',
        plannedHours,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
      },
    });

    if (employeeIds?.length) {
      await prisma.locationAssignment.createMany({
        data: employeeIds.map((eid: string) => ({
          locationId: location.id,
          employeeId: eid,
        })),
      });
    }

    res.status(201).json(location);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// GET /api/locations/:id/feed – chronological photo + report feed
router.get('/:id/feed', requireRole(['INHABER', 'STANDORTLEITER']), async (req, res) => {
  try {
    const { id } = req.params;

    const [media, reports] = await Promise.all([
      prisma.locationMedia.findMany({
        where: { locationId: id },
        include: { employee: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.locationReport.findMany({
        where: { locationId: id },
        include: { employee: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    // Merge and sort chronologically
    const feed = [
      ...media.map((m) => ({ type: 'media' as const, ...m })),
      ...reports.map((r) => ({ type: 'report' as const, ...r })),
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    res.json(feed);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

export default router;
