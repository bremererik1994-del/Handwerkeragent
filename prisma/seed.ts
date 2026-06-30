/**
 * Seed: Lederwaren-Einzelhandel Demo
 * Betrieb: "Lederwaren Müller", Einzelhandel, 1 Laden, 1 Inhaber + 4 Mitarbeiter
 *
 * Simulates a realistic week of WhatsApp-based time tracking so the owner
 * can immediately see plausible data after setup.
 */

import { PrismaClient } from '@prisma/client';
import { subDays, setHours, setMinutes } from 'date-fns';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding ZeitPilot demo data...');

  // ─── Company ─────────────────────────────────────────────────────────────────
  const company = await prisma.company.upsert({
    where: { waPhone: '+4915112345678' },
    update: {},
    create: {
      name: 'Lederwaren Müller GmbH',
      industry: 'EINZELHANDEL',
      waPhone: '+4915112345678',
      settings: {
        create: {
          nightSurchargeRate: 25,
          sundaySurchargeRate: 50,
          holidaySurchargeRate: 125,
          overtimeThresholdWeek: 38, // Einzelhandel TVöD-ähnlich
          minijobMonthlyLimit: 538,
          onboardingReminderHours: 24,
        },
      },
    },
  });

  // ─── Location: Ladengeschäft ──────────────────────────────────────────────
  const location = await prisma.location.upsert({
    where: { id: 'seed-location-laden-01' },
    update: {},
    create: {
      id: 'seed-location-laden-01',
      companyId: company.id,
      name: 'Laden Hauptstraße 42',
      address: 'Hauptstraße 42, 80331 München',
      locationType: 'LADEN',
      status: 'AKTIV',
    },
  });

  // ─── Employees ────────────────────────────────────────────────────────────
  const owner = await upsertEmployee(company.id, {
    name: 'Thomas Müller',
    phone: '+4915112345678',
    role: 'INHABER',
    employmentType: 'VOLLZEIT',
    hourlyRate: 0, // Inhaber rechnet anders
    onboardingState: 'ACTIVE',
    gdprConsent: true,
  });

  const anna = await upsertEmployee(company.id, {
    name: 'Anna Bauer',
    phone: '+4917612340001',
    role: 'MITARBEITER',
    employmentType: 'VOLLZEIT',
    hourlyRate: 14.5,
    onboardingState: 'ACTIVE',
    gdprConsent: true,
  });

  const max = await upsertEmployee(company.id, {
    name: 'Max Schneider',
    phone: '+4917612340002',
    role: 'MITARBEITER',
    employmentType: 'TEILZEIT',
    hourlyRate: 13.5,
    onboardingState: 'ACTIVE',
    gdprConsent: true,
  });

  const lena = await upsertEmployee(company.id, {
    name: 'Lena Hoffmann',
    phone: '+4917612340003',
    role: 'MITARBEITER',
    employmentType: 'MINIJOB',
    hourlyRate: 13.0,
    monthlyEarningsLimit: 538,
    onboardingState: 'ACTIVE',
    gdprConsent: true,
  });

  const newJoiner = await upsertEmployee(company.id, {
    name: 'Kemal Yilmaz',
    phone: '+4917612340004',
    role: 'MITARBEITER',
    employmentType: 'VOLLZEIT',
    hourlyRate: 13.0,
    // Still in onboarding – shows pending state on dashboard
    onboardingState: 'INVITED',
    gdprConsent: false,
  });

  // ─── Location Assignments ─────────────────────────────────────────────────
  for (const empId of [anna.id, max.id, lena.id]) {
    await prisma.locationAssignment.upsert({
      where: { locationId_employeeId: { locationId: location.id, employeeId: empId } },
      update: {},
      create: { locationId: location.id, employeeId: empId },
    });
  }

  // ─── Time Entries (last 5 work days) ─────────────────────────────────────
  const scenarios = [
    // [employee, dayOffset, startH, startM, endH, endM, breakMin]
    { emp: anna,  days: 0, sh: 9,  sm: 0,  eh: 17, em: 30, brk: 30 },
    { emp: anna,  days: 1, sh: 9,  sm: 0,  eh: 17, em: 0,  brk: 30 },
    { emp: anna,  days: 2, sh: 8,  sm: 30, eh: 16, em: 30, brk: 30 },
    { emp: anna,  days: 3, sh: 9,  sm: 0,  eh: 18, em: 0,  brk: 45 }, // slight overtime
    { emp: anna,  days: 4, sh: 9,  sm: 0,  eh: 14, em: 0,  brk: 0  }, // half day
    { emp: max,   days: 0, sh: 14, sm: 0,  eh: 19, em: 0,  brk: 15 },
    { emp: max,   days: 1, sh: 14, sm: 0,  eh: 19, em: 0,  brk: 15 },
    { emp: max,   days: 2, sh: 14, sm: 0,  eh: 19, em: 0,  brk: 15 },
    { emp: lena,  days: 0, sh: 10, sm: 0,  eh: 14, em: 0,  brk: 0  },
    { emp: lena,  days: 2, sh: 10, sm: 0,  eh: 14, em: 0,  brk: 0  },
    { emp: lena,  days: 4, sh: 10, sm: 0,  eh: 14, em: 0,  brk: 0  },
  ];

  for (const s of scenarios) {
    const day = subDays(new Date(), s.days);
    const startTime = setMinutes(setHours(day, s.sh), s.sm);
    const endTime = setMinutes(setHours(day, s.eh), s.em);
    const totalMinutes = Math.max(0, (s.eh * 60 + s.em) - (s.sh * 60 + s.sm) - s.brk);

    const msgId = `seed-msg-${s.emp.id}-${s.days}`;
    const waMsg = await prisma.whatsAppMessage.upsert({
      where: { waMessageId: msgId },
      update: {},
      create: {
        companyId: company.id,
        employeeId: s.emp.id,
        waMessageId: msgId,
        direction: 'INBOUND',
        content: `Start ${s.sh}:${String(s.sm).padStart(2,'0')} Laden Hauptstraße`,
        parsedIntent: 'START',
        parsedData: { intent: 'START', time: `${s.sh}:${String(s.sm).padStart(2,'0')}`, confidence: 'HIGH' },
        processingState: 'PROCESSED',
        sentAt: startTime,
      },
    });

    const entry = await prisma.timeEntry.upsert({
      where: { id: `seed-entry-${s.emp.id}-${s.days}` },
      update: {},
      create: {
        id: `seed-entry-${s.emp.id}-${s.days}`,
        employeeId: s.emp.id,
        companyId: company.id,
        locationId: location.id,
        startTime,
        endTime,
        breakMinutes: s.brk,
        totalMinutes,
        status: 'COMPLETED',
        sourceMessageId: waMsg.id,
        rawText: `Start ${s.sh}:${String(s.sm).padStart(2,'0')} Laden Hauptstraße`,
      },
    });

    await prisma.timeEntryAudit.upsert({
      where: { id: `seed-audit-${entry.id}` },
      update: {},
      create: {
        id: `seed-audit-${entry.id}`,
        entryId: entry.id,
        changedBy: 'system-seed',
        changeType: 'CREATE',
        newValue: entry as unknown as Record<string, unknown>,
      },
    });
  }

  // ─── Location Reports (WhatsApp demo scenario) ────────────────────────────
  await prisma.locationReport.upsert({
    where: { id: 'seed-report-lager-01' },
    update: {},
    create: {
      id: 'seed-report-lager-01',
      locationId: location.id,
      employeeId: anna.id,
      reportType: 'LAGER',
      content: 'Braune Damenhandtaschen fast ausverkauft, nur noch 2 Stück',
      data: { articleName: 'Damenhandtasche braun', stockStatus: 'LOW', quantity: 2 },
    },
  });

  await prisma.locationReport.upsert({
    where: { id: 'seed-report-umsatz-01' },
    update: {},
    create: {
      id: 'seed-report-umsatz-01',
      locationId: location.id,
      employeeId: max.id,
      reportType: 'UMSATZ',
      content: 'Umsatz heute 1.247 €',
      data: { amount: 1247, currency: 'EUR' },
    },
  });

  await prisma.locationReport.upsert({
    where: { id: 'seed-report-kasse-01' },
    update: {},
    create: {
      id: 'seed-report-kasse-01',
      locationId: location.id,
      employeeId: anna.id,
      reportType: 'KASSENABSCHLUSS',
      content: 'Kasse abgeschlossen, alles ok',
      data: { confirmed: true },
    },
  });

  // ─── Demo photo (placeholder URL) ────────────────────────────────────────
  await prisma.locationMedia.upsert({
    where: { id: 'seed-media-schaufenster-01' },
    update: {},
    create: {
      id: 'seed-media-schaufenster-01',
      locationId: location.id,
      employeeId: anna.id,
      url: 'https://images.unsplash.com/photo-1548036328-c9fa89d128fa?w=800', // Lederwaren placeholder
      mediaType: 'image',
      caption: 'Schaufenster neue Frühjahrskollektion aufgebaut',
      takenAt: subDays(new Date(), 1),
    },
  });

  // ─── Demo WhatsApp conversation (inbound messages) ────────────────────────
  const demoMessages = [
    { emp: anna,  intent: 'START',          content: 'Start 9:00 Laden Hauptstraße',   daysAgo: 0, hoursAgo: 8 },
    { emp: max,   intent: 'START',          content: 'Start 14:00',                    daysAgo: 0, hoursAgo: 5 },
    { emp: lena,  intent: 'START',          content: 'Bin da, starte 10:00',           daysAgo: 0, hoursAgo: 7 },
    { emp: lena,  intent: 'END',            content: 'Ende, Pause 0 Min',              daysAgo: 0, hoursAgo: 3 },
    { emp: anna,  intent: 'LAGER',          content: 'Braune Handtaschen fast leer!',  daysAgo: 0, hoursAgo: 4 },
    { emp: max,   intent: 'UMSATZ',         content: 'Umsatz heute 1247€',             daysAgo: 0, hoursAgo: 1 },
  ];

  for (let i = 0; i < demoMessages.length; i++) {
    const dm = demoMessages[i];
    const sentAt = new Date();
    sentAt.setDate(sentAt.getDate() - dm.daysAgo);
    sentAt.setHours(sentAt.getHours() - dm.hoursAgo);

    await prisma.whatsAppMessage.upsert({
      where: { waMessageId: `seed-demo-msg-${i}` },
      update: {},
      create: {
        companyId: company.id,
        employeeId: dm.emp.id,
        waMessageId: `seed-demo-msg-${i}`,
        direction: 'INBOUND',
        content: dm.content,
        parsedIntent: dm.intent,
        processingState: 'PROCESSED',
        sentAt,
      },
    });
  }

  console.log('✅ Seed complete!');
  console.log(`   Company: ${company.name} (${company.id})`);
  console.log(`   Location: ${location.name}`);
  console.log(`   Employees: Thomas (Inhaber), Anna, Max, Lena (Minijob), Kemal (noch nicht onboarded)`);
  console.log('');
  console.log('   Demo Login: POST /api/auth/login { companyId, phone: "+4915112345678" }');
}

async function upsertEmployee(
  companyId: string,
  data: {
    name: string;
    phone: string;
    role: 'INHABER' | 'MITARBEITER' | 'STANDORTLEITER';
    employmentType: 'VOLLZEIT' | 'TEILZEIT' | 'MINIJOB';
    hourlyRate?: number;
    monthlyEarningsLimit?: number;
    onboardingState: 'INVITED' | 'OPTED_IN' | 'TRAINED' | 'ACTIVE';
    gdprConsent: boolean;
  },
) {
  return prisma.employee.upsert({
    where: { phone: data.phone },
    update: {},
    create: {
      companyId,
      ...data,
      gdprConsentAt: data.gdprConsent ? new Date() : undefined,
    },
  });
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
