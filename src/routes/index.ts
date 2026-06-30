import { Router } from 'express';
import prisma from '../db';
import { authenticate, issueToken } from '../middleware/auth';
import { inviteEmployee } from '../modules/onboarding/service';
import { verifyWebhook, handleWebhook } from '../modules/whatsapp/webhook.handler';
import timetrackingRoutes from '../modules/timetracking/routes';
import locationRoutes from '../modules/location/routes';
import payrollRoutes from '../modules/payroll/routes';
import absenceRoutes from '../modules/absence/routes';

const router = Router();

// ─── WhatsApp Webhook (no auth) ───────────────────────────────────────────────
router.get('/webhook', verifyWebhook);
router.post('/webhook', handleWebhook);

// ─── Auth ─────────────────────────────────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
  try {
    const { companyId, phone } = req.body as { companyId: string; phone: string };
    const employee = await prisma.employee.findFirst({
      where: { phone, companyId, deletedAt: null },
    });
    if (!employee) { res.status(401).json({ error: 'Ungültige Zugangsdaten' }); return; }

    const token = issueToken({
      employeeId: employee.id,
      companyId: employee.companyId,
      role: employee.role,
    });
    res.json({ token, employee: { id: employee.id, name: employee.name, role: employee.role } });
  } catch {
    res.status(500).json({ error: 'Login fehlgeschlagen' });
  }
});

// ─── Company Onboarding (self-service, no auth needed for registration) ───────
router.post('/companies', async (req, res) => {
  try {
    const { name, industry, ownerName, ownerPhone } = req.body;

    const company = await prisma.company.create({
      data: {
        name,
        industry: industry ?? 'EINZELHANDEL',
        settings: {
          create: {
            overtimeThresholdWeek: industry === 'HANDWERK' ? 40 : 38,
            sundaySurchargeRate: industry === 'HANDWERK' ? 100 : 50,
          },
        },
        employees: {
          create: {
            name: ownerName,
            phone: ownerPhone,
            role: 'INHABER',
            employmentType: 'VOLLZEIT',
            onboardingState: 'ACTIVE',
            gdprConsent: true,
            gdprConsentAt: new Date(),
          },
        },
      },
      include: { employees: true, settings: true },
    });

    const owner = company.employees[0];
    const token = issueToken({
      employeeId: owner.id,
      companyId: company.id,
      role: 'INHABER',
    });

    res.status(201).json({ token, company, employee: owner });
  } catch {
    res.status(500).json({ error: 'Registrierung fehlgeschlagen' });
  }
});

// ─── Protected Routes ─────────────────────────────────────────────────────────
router.use(authenticate);

// Company info
router.get('/companies/me', async (req, res) => {
  try {
    const companyId = (req as any).user.companyId as string;
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      include: { settings: true, _count: { select: { employees: true, locations: true } } },
    });
    res.json(company);
  } catch {
    res.status(500).json({ error: 'Fehler' });
  }
});

// Employees CRUD
router.get('/employees', async (req, res) => {
  try {
    const companyId = (req as any).user.companyId as string;
    const employees = await prisma.employee.findMany({
      where: { companyId, deletedAt: null },
      include: {
        locationAssignments: { include: { location: { select: { id: true, name: true } } } },
        _count: { select: { timeEntries: true } },
      },
      orderBy: { name: 'asc' },
    });
    res.json(employees);
  } catch {
    res.status(500).json({ error: 'Fehler' });
  }
});

router.post('/employees', async (req, res) => {
  try {
    const companyId = (req as any).user.companyId as string;
    const { name, phone, employmentType, hourlyRate, monthlyEarningsLimit } = req.body;

    const employee = await prisma.employee.create({
      data: {
        companyId,
        name,
        phone,
        employmentType: employmentType ?? 'VOLLZEIT',
        hourlyRate,
        monthlyEarningsLimit,
        role: 'MITARBEITER',
        onboardingState: 'INVITED',
      },
    });

    await inviteEmployee(employee.id);

    res.status(201).json(employee);
  } catch {
    res.status(500).json({ error: 'Mitarbeiter konnte nicht angelegt werden' });
  }
});

router.get('/employees/:id', async (req, res) => {
  try {
    const companyId = (req as any).user.companyId as string;
    const employee = await prisma.employee.findFirst({
      where: { id: req.params.id, companyId, deletedAt: null },
      include: {
        locationAssignments: { include: { location: true } },
        _count: { select: { timeEntries: true, absences: true } },
      },
    });
    if (!employee) { res.status(404).json({ error: 'Nicht gefunden' }); return; }
    res.json(employee);
  } catch {
    res.status(500).json({ error: 'Fehler' });
  }
});

router.patch('/employees/:id', async (req, res) => {
  try {
    const companyId = (req as any).user.companyId as string;
    const { name, hourlyRate, employmentType, monthlyEarningsLimit } = req.body;
    await prisma.employee.updateMany({
      where: { id: req.params.id, companyId, deletedAt: null },
      data: { name, hourlyRate, employmentType, monthlyEarningsLimit },
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Fehler' });
  }
});

router.delete('/employees/:id', async (req, res) => {
  try {
    const companyId = (req as any).user.companyId as string;
    await prisma.employee.updateMany({
      where: { id: req.params.id, companyId },
      data: { deletedAt: new Date() },
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Fehler' });
  }
});

// Dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const companyId = (req as any).user.companyId as string;
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const [employees, locations, runningEntries, recentMessages, absencesThisMonth] = await Promise.all([
      prisma.employee.findMany({
        where: { companyId, deletedAt: null },
        select: { id: true, name: true, onboardingState: true, phone: true },
      }),
      prisma.location.findMany({
        where: { companyId, status: 'AKTIV' },
        include: {
          assignments: { include: { employee: { select: { id: true, name: true } } } },
          _count: { select: { reports: true, media: true } },
        },
      }),
      prisma.timeEntry.findMany({
        where: { companyId, status: 'RUNNING' },
        include: {
          employee: { select: { name: true } },
          location: { select: { name: true } },
        },
      }),
      prisma.whatsAppMessage.findMany({
        where: { companyId, direction: 'INBOUND' },
        include: { employee: { select: { name: true } } },
        orderBy: { sentAt: 'desc' },
        take: 20,
      }),
      prisma.absence.findMany({
        where: { companyId, startDate: { gte: startOfMonth }, deletedAt: null },
        include: { employee: { select: { name: true } } },
        orderBy: { startDate: 'desc' },
      }),
    ]);

    res.json({ employees, locations, runningEntries, recentMessages, absencesThisMonth });
  } catch {
    res.status(500).json({ error: 'Fehler' });
  }
});

// Sub-routers
router.use('/time-entries', timetrackingRoutes);
router.use('/locations', locationRoutes);
router.use('/payroll', payrollRoutes);
router.use('/absences', absenceRoutes);

export default router;
