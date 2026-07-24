import { Router } from 'express';
import prisma from '../db';

const router = Router();

// ─── Token-Auth helper ────────────────────────────────────────────────────────

async function getCompanyByToken(token: string) {
  return prisma.company.findUnique({
    where: { dashboardToken: token },
    include: { settings: true },
  });
}

function startOfWeek() {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ─── GET /api/view/:token — dashboard data ────────────────────────────────────

router.get('/:token', async (req, res) => {
  try {
    const company = await getCompanyByToken(req.params.token);
    if (!company) { res.status(404).json({ error: 'Nicht gefunden' }); return; }

    const [employees, runningEntries, weekEntries, monthAbsences, locations] = await Promise.all([
      prisma.employee.findMany({
        where: { companyId: company.id, deletedAt: null, role: { not: 'INHABER' } },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, phone: true, employmentType: true, onboardingState: true },
      }),
      prisma.timeEntry.findMany({
        where: { companyId: company.id, status: 'RUNNING' },
        include: { employee: { select: { id: true, name: true } }, location: { select: { name: true } } },
      }),
      prisma.timeEntry.findMany({
        where: { companyId: company.id, status: { in: ['COMPLETED', 'CORRECTED'] }, startTime: { gte: startOfWeek() } },
        include: { employee: { select: { id: true, name: true } }, location: { select: { name: true } } },
        orderBy: { startTime: 'desc' },
      }),
      prisma.absence.findMany({
        where: { companyId: company.id, deletedAt: null, startDate: { gte: startOfMonth() } },
        include: { employee: { select: { id: true, name: true } } },
        orderBy: { startDate: 'desc' },
      }),
      prisma.location.findMany({
        where: { companyId: company.id, status: 'AKTIV' },
        include: {
          assignments: { include: { employee: { select: { id: true, name: true } } } },
        },
        orderBy: { name: 'asc' },
      }),
    ]);

    res.json({ company: { id: company.id, name: company.name, industry: company.industry }, employees, runningEntries, weekEntries, monthAbsences, locations });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Fehler' });
  }
});

// ─── PATCH /api/view/:token/entries/:id — Eintrag bearbeiten ─────────────────

router.patch('/:token/entries/:id', async (req, res) => {
  try {
    const company = await getCompanyByToken(req.params.token);
    if (!company) { res.status(404).json({ error: 'Nicht gefunden' }); return; }

    const { startTime, endTime, breakMinutes } = req.body as {
      startTime?: string; endTime?: string; breakMinutes?: number;
    };

    const entry = await prisma.timeEntry.findFirst({
      where: { id: req.params.id, companyId: company.id },
    });
    if (!entry) { res.status(404).json({ error: 'Eintrag nicht gefunden' }); return; }

    const start = startTime ? new Date(startTime) : entry.startTime;
    const end   = endTime   ? new Date(endTime)   : entry.endTime;
    const brk   = breakMinutes ?? entry.breakMinutes;
    const totalMinutes = end
      ? Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000) - brk)
      : null;

    const updated = await prisma.timeEntry.update({
      where: { id: req.params.id },
      data: {
        startTime: start,
        endTime: end ?? undefined,
        breakMinutes: brk,
        totalMinutes,
        status: end ? 'CORRECTED' : entry.status,
      },
    });

    await prisma.timeEntryAudit.create({
      data: {
        entryId: req.params.id,
        changedBy: 'INHABER',
        changeType: 'CORRECT',
        oldValue: { startTime: entry.startTime, endTime: entry.endTime, breakMinutes: entry.breakMinutes } as any,
        newValue: { startTime: start, endTime: end, breakMinutes: brk } as any,
        reason: 'Manuell korrigiert über Dashboard',
      },
    });

    res.json(updated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Fehler beim Speichern' });
  }
});

// ─── DELETE /api/view/:token/entries/:id ─────────────────────────────────────

router.delete('/:token/entries/:id', async (req, res) => {
  try {
    const company = await getCompanyByToken(req.params.token);
    if (!company) { res.status(404).json({ error: 'Nicht gefunden' }); return; }

    await prisma.timeEntry.deleteMany({ where: { id: req.params.id, companyId: company.id } });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Fehler' });
  }
});

// ─── PATCH /api/view/:token/absences/:id — Status ändern ────────────────────

router.patch('/:token/absences/:id', async (req, res) => {
  try {
    const company = await getCompanyByToken(req.params.token);
    if (!company) { res.status(404).json({ error: 'Nicht gefunden' }); return; }

    const { status } = req.body as { status: 'BESTAETIGT' | 'ABGELEHNT' };
    await prisma.absence.updateMany({
      where: { id: req.params.id, companyId: company.id },
      data: { status },
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Fehler' });
  }
});

// ─── GET /api/view/:token/export/stunden — CSV Arbeitsstunden ────────────────

router.get('/:token/export/stunden', async (req, res) => {
  try {
    const company = await getCompanyByToken(req.params.token);
    if (!company) { res.status(404).json({ error: 'Nicht gefunden' }); return; }

    const { von, bis } = req.query as { von?: string; bis?: string };
    const from = von ? new Date(von) : startOfMonth();
    const to   = bis ? new Date(bis) : new Date();

    const entries = await prisma.timeEntry.findMany({
      where: { companyId: company.id, startTime: { gte: from, lte: to }, status: { in: ['COMPLETED', 'CORRECTED'] } },
      include: { employee: { select: { name: true, employmentType: true } }, location: { select: { name: true } } },
      orderBy: [{ employee: { name: 'asc' } }, { startTime: 'asc' }],
    });

    const fmt = (d: Date | null) => d ? d.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }) : '';
    const rows = [
      ['Mitarbeiter', 'Beschäftigungsart', 'Datum', 'Start', 'Ende', 'Pause (Min)', 'Gesamt (Min)', 'Gesamt (h)', 'Baustelle/Ort', 'Status'].join(';'),
      ...entries.map(e => [
        e.employee.name,
        e.employee.employmentType,
        e.startTime.toLocaleDateString('de-DE'),
        fmt(e.startTime),
        fmt(e.endTime),
        e.breakMinutes,
        e.totalMinutes ?? '',
        e.totalMinutes ? (e.totalMinutes / 60).toFixed(2) : '',
        e.location?.name ?? '',
        e.status,
      ].join(';')),
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="stunden_${company.name}_${from.toISOString().slice(0,10)}.csv"`);
    res.send('﻿' + rows.join('\r\n')); // BOM for Excel
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Export fehlgeschlagen' });
  }
});

// ─── GET /api/view/:token/export/abwesenheiten — CSV Abwesenheiten ───────────

router.get('/:token/export/abwesenheiten', async (req, res) => {
  try {
    const company = await getCompanyByToken(req.params.token);
    if (!company) { res.status(404).json({ error: 'Nicht gefunden' }); return; }

    const { von, bis } = req.query as { von?: string; bis?: string };
    const from = von ? new Date(von) : startOfMonth();
    const to   = bis ? new Date(bis) : new Date();

    const absences = await prisma.absence.findMany({
      where: { companyId: company.id, startDate: { gte: from, lte: to }, deletedAt: null },
      include: { employee: { select: { name: true } } },
      orderBy: [{ employee: { name: 'asc' } }, { startDate: 'asc' }],
    });

    const rows = [
      ['Mitarbeiter', 'Art', 'Von', 'Bis', 'Tage', 'Status', 'Notiz'].join(';'),
      ...absences.map(a => [
        a.employee.name,
        a.type,
        a.startDate.toLocaleDateString('de-DE'),
        a.endDate.toLocaleDateString('de-DE'),
        a.durationDays,
        a.status,
        a.note ?? '',
      ].join(';')),
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="abwesenheiten_${company.name}_${from.toISOString().slice(0,10)}.csv"`);
    res.send('﻿' + rows.join('\r\n'));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Export fehlgeschlagen' });
  }
});

export default router;
