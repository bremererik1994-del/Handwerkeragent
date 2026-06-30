import { format, parseISO, differenceInMinutes } from 'date-fns';
import prisma from '../../db';
import { getWhatsAppProvider } from '../whatsapp';
import { markEmployeeActive } from '../onboarding/service';
import type { ParsedMessage } from '../nlp/message.parser';
import type { Employee } from '@prisma/client';

export async function handleTimeTrackingIntent(
  employee: Employee,
  parsed: ParsedMessage,
  sourceMessageId: string,
  phone: string,
) {
  const wa = getWhatsAppProvider();

  if (parsed.intent === 'START') {
    const startTime = parseTimeString(parsed.time);

    // Find current running entry – if exists, auto-close it
    const running = await prisma.timeEntry.findFirst({
      where: { employeeId: employee.id, status: 'RUNNING' },
    });
    if (running) {
      await closeEntry(running.id, startTime, 0);
      await wa.sendMessage({
        to: phone,
        text: '⚠️ Deine vorherige offene Schicht wurde automatisch geschlossen.',
      });
    }

    // Resolve location from hint
    const locationId = await resolveLocation(employee.companyId, parsed.locationHint);

    const entry = await prisma.timeEntry.create({
      data: {
        employeeId: employee.id,
        companyId: employee.companyId,
        locationId,
        startTime,
        status: 'RUNNING',
        sourceMessageId,
        rawText: parsed.rawText,
      },
    });

    await createAuditLog(entry.id, employee.id, 'CREATE', null, entry);
    await markEmployeeActive(employee.id);

    // Minijob warning check
    await checkMinijobLimit(employee, phone);

    await wa.sendMessage({
      to: phone,
      text: `✅ Schichtbeginn erfasst: ${format(startTime, 'HH:mm')} Uhr.\nGute Arbeit!`,
    });

  } else if (parsed.intent === 'END') {
    const running = await prisma.timeEntry.findFirst({
      where: { employeeId: employee.id, status: 'RUNNING' },
    });

    if (!running) {
      await wa.sendMessage({
        to: phone,
        text: '⚠️ Kein laufender Arbeitseintrag gefunden. Hast du heute mit "Start HH:MM" begonnen?',
      });
      return;
    }

    const endTime = parsed.time ? parseTimeString(parsed.time) : new Date();
    const breakMinutes = parsed.breakMinutes ?? 0;
    const updated = await closeEntry(running.id, endTime, breakMinutes);

    await createAuditLog(running.id, employee.id, 'UPDATE', running, updated);

    const hours = Math.floor((updated.totalMinutes ?? 0) / 60);
    const mins = (updated.totalMinutes ?? 0) % 60;

    await wa.sendMessage({
      to: phone,
      text: `✅ Schichtende erfasst: ${format(endTime, 'HH:mm')} Uhr.\nArbeitszeit heute: ${hours}h ${mins}min (Pause: ${breakMinutes} Min)`,
    });

  } else if (parsed.intent === 'DAY_ENTRY') {
    await handleDayEntry(employee, parsed, sourceMessageId, phone);

  } else if (parsed.intent === 'BREAK') {
    const running = await prisma.timeEntry.findFirst({
      where: { employeeId: employee.id, status: 'RUNNING' },
    });
    if (!running) return;

    const newBreak = (running.breakMinutes ?? 0) + (parsed.breakMinutes ?? 0);
    await prisma.timeEntry.update({
      where: { id: running.id },
      data: { breakMinutes: newBreak },
    });

    await wa.sendMessage({
      to: phone,
      text: `⏸ Pause von ${parsed.breakMinutes} Min vermerkt. Gesamte Pause heute: ${newBreak} Min.`,
    });
  }
}

async function closeEntry(entryId: string, endTime: Date, breakMinutes: number) {
  const entry = await prisma.timeEntry.findUniqueOrThrow({ where: { id: entryId } });
  const grossMinutes = differenceInMinutes(endTime, entry.startTime);
  const totalMinutes = Math.max(0, grossMinutes - breakMinutes);

  return prisma.timeEntry.update({
    where: { id: entryId },
    data: { endTime, breakMinutes, totalMinutes, status: 'COMPLETED' },
  });
}

function parseTimeString(timeStr?: string): Date {
  if (!timeStr) return new Date();
  const [hours, minutes] = timeStr.split(':').map(Number);
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  return d;
}

async function resolveLocation(companyId: string, hint?: string): Promise<string | undefined> {
  if (!hint) {
    // Default to single active location if only one exists
    const locations = await prisma.location.findMany({
      where: { companyId, status: 'AKTIV' },
    });
    return locations.length === 1 ? locations[0].id : undefined;
  }

  const loc = await prisma.location.findFirst({
    where: {
      companyId,
      name: { contains: hint, mode: 'insensitive' },
    },
  });
  return loc?.id;
}

async function createAuditLog(
  entryId: string,
  changedBy: string,
  changeType: string,
  oldValue: unknown,
  newValue: unknown,
) {
  await prisma.timeEntryAudit.create({
    data: {
      entryId,
      changedBy,
      changeType,
      oldValue: oldValue ? (oldValue as unknown as any) : undefined,
      newValue: newValue ? (newValue as unknown as any) : undefined,
    },
  });
}

// DAY_ENTRY: complete shift booked in one message at end of day
async function handleDayEntry(
  employee: Employee,
  parsed: ParsedMessage,
  sourceMessageId: string,
  phone: string,
) {
  const wa = getWhatsAppProvider();

  // Close any accidentally open running entry for today first
  const running = await prisma.timeEntry.findFirst({
    where: { employeeId: employee.id, status: 'RUNNING' },
  });
  if (running) {
    await prisma.timeEntry.update({
      where: { id: running.id },
      data: { status: 'COMPLETED', endTime: new Date() },
    });
  }

  const locationId = await resolveLocation(employee.companyId, parsed.locationHint);
  const breakMinutes = parsed.breakMinutes ?? 0;

  let startTime: Date;
  let endTime: Date;
  let totalMinutes: number;

  if (parsed.startTime && parsed.endTime) {
    startTime = parseTimeString(parsed.startTime);
    endTime = parseTimeString(parsed.endTime);
    const gross = differenceInMinutes(endTime, startTime);
    totalMinutes = Math.max(0, gross - breakMinutes);
  } else if (parsed.totalHours) {
    // "8h" without explicit times: anchor end to now, derive start
    endTime = new Date();
    totalMinutes = Math.round(parsed.totalHours * 60);
    startTime = new Date(endTime.getTime() - (totalMinutes + breakMinutes) * 60_000);
  } else {
    await wa.sendMessage({
      to: phone,
      text: '❓ Bitte im Format "9:00-17:30" oder "8,5h" senden.',
    });
    return;
  }

  const entry = await prisma.timeEntry.create({
    data: {
      employeeId: employee.id,
      companyId: employee.companyId,
      locationId,
      startTime,
      endTime,
      breakMinutes,
      totalMinutes,
      status: 'COMPLETED',
      sourceMessageId,
      rawText: parsed.rawText,
    },
  });

  await createAuditLog(entry.id, employee.id, 'CREATE', null, entry);
  await markEmployeeActive(employee.id);
  await checkMinijobLimit(employee, phone);

  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;

  await wa.sendMessage({
    to: phone,
    text:
      `✅ Tag erfasst: ${format(startTime, 'HH:mm')}–${format(endTime, 'HH:mm')} Uhr` +
      (breakMinutes ? `, Pause ${breakMinutes} Min` : '') +
      `\nArbeitszeit: ${hours}h ${mins}min. Danke!`,
  });
}

async function checkMinijobLimit(employee: Employee, phone: string) {
  if (employee.employmentType !== 'MINIJOB') return;

  const settings = await prisma.companySettings.findUnique({
    where: { companyId: employee.companyId },
  });
  const limit = employee.monthlyEarningsLimit ?? settings?.minijobMonthlyLimit ?? 538;
  const hourlyRate = employee.hourlyRate;
  if (!hourlyRate) return;

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const entries = await prisma.timeEntry.findMany({
    where: {
      employeeId: employee.id,
      status: 'COMPLETED',
      startTime: { gte: startOfMonth },
    },
  });

  const totalHours = entries.reduce((sum, e) => sum + (e.totalMinutes ?? 0) / 60, 0);
  const estimatedEarnings = totalHours * hourlyRate;
  const remaining = limit - estimatedEarnings;

  if (remaining < limit * 0.1) {
    const wa = getWhatsAppProvider();
    await wa.sendMessage({
      to: phone,
      text: `⚠️ *Minijob-Hinweis:* Dein geschätztes Monatsgehalt nähert sich der Grenze von ${limit} €. Bitte mit dem Inhaber abstimmen.`,
    });
  }
}
