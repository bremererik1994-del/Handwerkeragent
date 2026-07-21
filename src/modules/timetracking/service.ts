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
  opts?: { beginnerMode?: boolean },
) {
  const beginnerMode = opts?.beginnerMode ?? false;
  void beginnerMode; // reserved for graduated responses in future
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

  } else if (parsed.intent === 'RETROACTIVE') {
    await handleRetroactive(employee, parsed, sourceMessageId, phone);

  } else if (parsed.intent === 'CORRECTION') {
    await handleCorrection(employee, parsed, sourceMessageId, phone);

  } else if (parsed.intent === 'QUERY_HOURS') {
    await handleQueryHours(employee, phone);

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

// ─── Retroactive booking ──────────────────────────────────────────────────────

async function handleRetroactive(
  employee: Employee,
  parsed: ParsedMessage,
  sourceMessageId: string,
  phone: string,
) {
  const wa = getWhatsAppProvider();
  const date = parsed.retroactiveDate!;

  // Check for duplicate: already have a COMPLETED entry that day?
  const dayStart = new Date(date + 'T00:00:00');
  const dayEnd = new Date(date + 'T23:59:59');
  const existing = await prisma.timeEntry.findFirst({
    where: { employeeId: employee.id, startTime: { gte: dayStart, lte: dayEnd }, status: 'COMPLETED' },
  });
  if (existing) {
    const label = formatDateLabel(date);
    await wa.sendMessage({
      to: phone,
      text:
        `ℹ️ Für *${label}* gibt es bereits einen Eintrag ` +
        `(${format(existing.startTime, 'HH:mm')}–${existing.endTime ? format(existing.endTime, 'HH:mm') : '?'} Uhr).\n\n` +
        `Falls das falsch ist, schreib: _Korrektur ${label} HH:MM–HH:MM_`,
    });
    return;
  }

  const locationId = await resolveLocation(employee.companyId, parsed.locationHint);
  const breakMinutes = parsed.breakMinutes ?? 0;
  let startTime: Date;
  let endTime: Date;
  let totalMinutes: number;

  if (parsed.startTime && parsed.endTime) {
    startTime = parseDateTimeString(date, parsed.startTime);
    endTime = parseDateTimeString(date, parsed.endTime);
    const gross = differenceInMinutes(endTime, startTime);
    totalMinutes = Math.max(0, gross - breakMinutes);
  } else if (parsed.totalHours) {
    totalMinutes = Math.round(parsed.totalHours * 60);
    startTime = parseDateTimeString(date, '08:00');
    endTime = new Date(startTime.getTime() + (totalMinutes + breakMinutes) * 60_000);
  } else {
    await wa.sendMessage({
      to: phone,
      text: `❓ Welche Zeiten für *${formatDateLabel(date)}*? Beispiel: _${formatDateLabel(date)} 8:00–17:00_`,
    });
    return;
  }

  // Plausibility check
  if (totalMinutes > 14 * 60) {
    await wa.sendMessage({
      to: phone,
      text: `⚠️ Die Arbeitszeit für *${formatDateLabel(date)}* wäre über 14 Stunden – ist das korrekt? Bitte korrigiere die Zeiten.`,
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

  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  await wa.sendMessage({
    to: phone,
    text:
      `✅ Nachgetragen für *${formatDateLabel(date)}*: ` +
      `${format(startTime, 'HH:mm')}–${format(endTime, 'HH:mm')} Uhr` +
      (breakMinutes ? `, Pause ${breakMinutes} Min` : '') +
      ` = ${h}h ${m}min.`,
  });
}

// ─── Correction ───────────────────────────────────────────────────────────────

async function handleCorrection(
  employee: Employee,
  parsed: ParsedMessage,
  sourceMessageId: string,
  phone: string,
) {
  const wa = getWhatsAppProvider();
  const date = parsed.retroactiveDate ?? new Date().toISOString().slice(0, 10);
  const dayStart = new Date(date + 'T00:00:00');
  const dayEnd = new Date(date + 'T23:59:59');

  // Find the entry to correct (most recent COMPLETED on that day, or RUNNING today)
  const entry = await prisma.timeEntry.findFirst({
    where: {
      employeeId: employee.id,
      startTime: { gte: dayStart, lte: dayEnd },
      status: { in: ['COMPLETED', 'RUNNING'] },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!entry) {
    const label = formatDateLabel(date);
    await wa.sendMessage({
      to: phone,
      text: `ℹ️ Ich habe keinen Eintrag für *${label}* gefunden, den ich korrigieren könnte.`,
    });
    return;
  }

  const oldSnapshot = { ...entry };
  const breakMinutes = parsed.breakMinutes ?? entry.breakMinutes ?? 0;

  let startTime = entry.startTime;
  let endTime = entry.endTime ?? undefined;
  let totalMinutes = entry.totalMinutes ?? 0;

  if (parsed.startTime) startTime = parseDateTimeString(date, parsed.startTime);
  if (parsed.endTime) endTime = parseDateTimeString(date, parsed.endTime);

  if (parsed.totalHours) {
    totalMinutes = Math.round(parsed.totalHours * 60);
    if (!parsed.startTime) endTime = new Date(startTime.getTime() + (totalMinutes + breakMinutes) * 60_000);
  } else if (endTime) {
    const gross = differenceInMinutes(endTime, startTime);
    totalMinutes = Math.max(0, gross - breakMinutes);
  }

  // Plausibility
  if (totalMinutes > 14 * 60) {
    await wa.sendMessage({
      to: phone,
      text: `⚠️ Die korrigierten Zeiten ergeben mehr als 14 Stunden – bitte prüfe nochmal.`,
    });
    return;
  }

  const updated = await prisma.timeEntry.update({
    where: { id: entry.id },
    data: {
      startTime,
      endTime,
      breakMinutes,
      totalMinutes,
      status: 'CORRECTED',
      rawText: parsed.rawText,
    },
  });
  await createAuditLog(entry.id, employee.id, 'CORRECT', oldSnapshot, updated);

  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const label = formatDateLabel(date);

  await wa.sendMessage({
    to: phone,
    text:
      `✅ Korrigiert für *${label}*: ` +
      `${format(startTime, 'HH:mm')}–${endTime ? format(endTime, 'HH:mm') : '?'} Uhr` +
      (breakMinutes ? `, Pause ${breakMinutes} Min` : '') +
      ` = ${h}h ${m}min.`,
  });
}

// ─── Query hours ──────────────────────────────────────────────────────────────

async function handleQueryHours(employee: Employee, phone: string) {
  const wa = getWhatsAppProvider();
  const today = new Date();

  // This week (Mon–today)
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  startOfWeek.setHours(0, 0, 0, 0);

  const entries = await prisma.timeEntry.findMany({
    where: {
      employeeId: employee.id,
      status: { in: ['COMPLETED', 'CORRECTED'] },
      startTime: { gte: startOfWeek },
    },
    orderBy: { startTime: 'asc' },
  });

  if (entries.length === 0) {
    await wa.sendMessage({ to: phone, text: `📊 Diese Woche habe ich noch keine Buchungen von dir.` });
    return;
  }

  const totalMin = entries.reduce((s, e) => s + (e.totalMinutes ?? 0), 0);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;

  const lines = entries.map(e => {
    const dayName = format(e.startTime, 'EEEE', { locale: undefined });
    const eh = Math.floor((e.totalMinutes ?? 0) / 60);
    const em = (e.totalMinutes ?? 0) % 60;
    return `• ${format(e.startTime, 'dd.MM.')} ${format(e.startTime, 'HH:mm')}–${e.endTime ? format(e.endTime, 'HH:mm') : '?'}: ${eh}h ${em}min`;
  });

  await wa.sendMessage({
    to: phone,
    text:
      `📊 *Diese Woche (${format(startOfWeek, 'dd.MM.')}–heute):*\n\n` +
      lines.join('\n') +
      `\n\n*Gesamt: ${h}h ${m}min*`,
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDateTimeString(date: string, time: string): Date {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(date + 'T00:00:00');
  d.setHours(h, m, 0, 0);
  return d;
}

function formatDateLabel(isoDate: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (isoDate === today) return 'heute';
  if (isoDate === yesterday) return 'gestern';
  const d = new Date(isoDate);
  return format(d, 'dd.MM.yyyy');
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
