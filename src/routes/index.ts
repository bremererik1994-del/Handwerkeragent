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
    const now = new Date();
    // Lohnunterlagen müssen gem. §41 EStG / §147 AO 6 Jahre aufbewahrt werden,
    // daher kein Hartlöschen vor Ablauf dieser Frist.
    const retainUntil = new Date(now);
    retainUntil.setFullYear(retainUntil.getFullYear() + 6);
    await prisma.employee.updateMany({
      where: { id: req.params.id, companyId },
      data: { deletedAt: now, retainUntil },
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

// ─── DSGVO: Datenauskunft (Art. 15) + Export (Art. 20) ───────────────────────
router.get('/gdpr/export', async (req, res) => {
  try {
    const { employeeId, companyId } = (req as any).user;

    const employee = await prisma.employee.findFirst({
      where: { id: employeeId, companyId, deletedAt: null },
      include: {
        company: { select: { name: true, industry: true } },
        timeEntries: {
          orderBy: { startTime: 'desc' },
          select: { startTime: true, endTime: true, breakMinutes: true, totalMinutes: true, status: true },
        },
        absences: {
          where: { deletedAt: null },
          select: { type: true, status: true, startDate: true, endDate: true, durationDays: true },
        },
      },
    });

    if (!employee) { res.status(404).json({ error: 'Nicht gefunden' }); return; }

    res.json({
      exportedAt: new Date().toISOString(),
      legalBasis: 'Art. 20 DSGVO – Recht auf Datenübertragbarkeit',
      personalData: {
        name: employee.name,
        phone: employee.phone,
        role: employee.role,
        employmentType: employee.employmentType,
        gdprConsent: employee.gdprConsent,
        gdprConsentAt: employee.gdprConsentAt,
        createdAt: employee.createdAt,
      },
      company: employee.company,
      timeEntries: employee.timeEntries,
      absences: employee.absences,
    });
  } catch {
    res.status(500).json({ error: 'Export fehlgeschlagen' });
  }
});

// DSGVO: Einwilligung widerrufen (Art. 7 Abs. 3) – setzt Consent zurück, löschmarke nach Fristablauf
router.post('/gdpr/revoke-consent', async (req, res) => {
  try {
    const { employeeId, companyId, role } = (req as any).user;

    // INHABER cannot self-revoke while company is active — must delete account
    if (role === 'INHABER') {
      res.status(400).json({
        error: 'Als Inhaber kannst du die Einwilligung nicht einzeln widerrufen. Bitte kontaktiere den Support zur Kontolöschung.',
      });
      return;
    }

    await prisma.employee.update({
      where: { id: employeeId, companyId },
      data: { gdprConsent: false, onboardingState: 'INVITED' },
    });

    res.json({ ok: true, message: 'Einwilligung widerrufen. Deine Daten werden nach Ablauf der gesetzlichen Aufbewahrungsfristen gelöscht.' });
  } catch {
    res.status(500).json({ error: 'Widerruf fehlgeschlagen' });
  }
});

// Sub-routers
router.use('/time-entries', timetrackingRoutes);
router.use('/locations', locationRoutes);
router.use('/payroll', payrollRoutes);
router.use('/absences', absenceRoutes);

export default router;
