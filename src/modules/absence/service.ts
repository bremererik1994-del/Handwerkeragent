import type { Employee } from '@prisma/client';
import prisma from '../../db';
import { getWhatsAppProvider } from '../whatsapp/index';
import type { ParsedMessage } from '../nlp/message.parser';

type EmployeeWithCompany = Employee & {
  company: { id: string; name: string };
};

// Resolve start/end dates from parsed intent fields
function resolveDateRange(
  durationDays: number,
  fromStr?: string,
): { startDate: Date; endDate: Date } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let startDate = today;

  if (fromStr) {
    // Try "DD.MM." format
    const ddmm = fromStr.match(/^(\d{1,2})\.(\d{1,2})\./);
    if (ddmm) {
      const d = new Date(today.getFullYear(), parseInt(ddmm[2]) - 1, parseInt(ddmm[1]));
      if (!isNaN(d.getTime())) startDate = d;
    }
    // Try weekday name (simple: next occurrence)
    const weekdays: Record<string, number> = {
      montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4,
      freitag: 5, samstag: 6, sonntag: 0,
    };
    const wd = weekdays[fromStr.toLowerCase()];
    if (wd !== undefined) {
      const d = new Date(today);
      const diff = (wd - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + diff);
      startDate = d;
    }
  }

  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + durationDays - 1);

  return { startDate, endDate };
}

// Find the Inhaber phone for this company to send notifications
async function getInhaberPhone(companyId: string): Promise<string | null> {
  const inhaber = await prisma.employee.findFirst({
    where: { companyId, role: 'INHABER', deletedAt: null },
    select: { phone: true },
  });
  return inhaber?.phone ?? null;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export async function handleKrank(
  employee: EmployeeWithCompany,
  parsed: ParsedMessage,
  sourceMessageId: string,
  fromPhone: string,
): Promise<void> {
  const wa = getWhatsAppProvider();
  const duration = parsed.durationDays ?? 1;
  const { startDate, endDate } = resolveDateRange(duration, parsed.from);

  const absence = await prisma.absence.create({
    data: {
      employeeId: employee.id,
      companyId: employee.companyId,
      type: 'KRANK',
      status: 'GEMELDET',
      startDate,
      endDate,
      durationDays: duration,
      sourceMessageId,
    },
  });

  const dayLabel = duration === 1 ? 'heute' : `vom ${formatDate(startDate)} bis ${formatDate(endDate)}`;
  await wa.sendMessage({
    to: fromPhone,
    text: `🤒 Gute Besserung, ${employee.name.split(' ')[0]}! Deine Krankmeldung (${dayLabel}) wurde erfasst. Dein Chef wurde informiert.`,
  });

  const inhaberPhone = await getInhaberPhone(employee.companyId);
  if (inhaberPhone && inhaberPhone !== fromPhone) {
    await wa.sendMessage({
      to: inhaberPhone,
      text: `🤒 *Krankmeldung:* ${employee.name} ist ${dayLabel} krank. (ID: ${absence.id.slice(-6)})`,
    });
  }
}

export async function handleUrlaub(
  employee: EmployeeWithCompany,
  parsed: ParsedMessage,
  sourceMessageId: string,
  fromPhone: string,
): Promise<void> {
  const wa = getWhatsAppProvider();
  const duration = parsed.durationDays ?? 1;
  const { startDate, endDate } = resolveDateRange(duration, parsed.from);

  const absence = await prisma.absence.create({
    data: {
      employeeId: employee.id,
      companyId: employee.companyId,
      type: 'URLAUB',
      status: 'GEMELDET',
      startDate,
      endDate,
      durationDays: duration,
      sourceMessageId,
    },
  });

  const dayLabel =
    duration === 1
      ? `am ${formatDate(startDate)}`
      : `vom ${formatDate(startDate)} bis ${formatDate(endDate)} (${duration} Tage)`;

  await wa.sendMessage({
    to: fromPhone,
    text: `🏖️ Urlaubsantrag erfasst: ${dayLabel}. Dein Chef muss noch bestätigen.`,
  });

  const inhaberPhone = await getInhaberPhone(employee.companyId);
  if (inhaberPhone && inhaberPhone !== fromPhone) {
    await wa.sendMessage({
      to: inhaberPhone,
      text: `🏖️ *Urlaubsantrag:* ${employee.name} möchte Urlaub ${dayLabel}. Bitte bestätigen oder ablehnen. (ID: ${absence.id.slice(-6)})`,
    });
  }
}

export async function handleZeitausgleich(
  employee: EmployeeWithCompany,
  parsed: ParsedMessage,
  sourceMessageId: string,
  fromPhone: string,
): Promise<void> {
  const wa = getWhatsAppProvider();
  const duration = parsed.durationDays ?? 1;
  const { startDate, endDate } = resolveDateRange(duration, parsed.from);

  const absence = await prisma.absence.create({
    data: {
      employeeId: employee.id,
      companyId: employee.companyId,
      type: 'ZEITAUSGLEICH',
      status: 'GEMELDET',
      startDate,
      endDate,
      durationDays: duration,
      sourceMessageId,
    },
  });

  const dayLabel =
    duration === 1
      ? `am ${formatDate(startDate)}`
      : `vom ${formatDate(startDate)} bis ${formatDate(endDate)}`;

  await wa.sendMessage({
    to: fromPhone,
    text: `⚖️ Zeitausgleich erfasst: ${dayLabel}. Chef wurde informiert. (ID: ${absence.id.slice(-6)})`,
  });

  const inhaberPhone = await getInhaberPhone(employee.companyId);
  if (inhaberPhone && inhaberPhone !== fromPhone) {
    await wa.sendMessage({
      to: inhaberPhone,
      text: `⚖️ *Zeitausgleich:* ${employee.name} nimmt ${dayLabel} Zeitausgleich. (ID: ${absence.id.slice(-6)})`,
    });
  }
}

export async function handleSonderurlaub(
  employee: EmployeeWithCompany,
  parsed: ParsedMessage,
  sourceMessageId: string,
  fromPhone: string,
): Promise<void> {
  const wa = getWhatsAppProvider();
  const duration = parsed.durationDays ?? 1;
  const { startDate, endDate } = resolveDateRange(duration, parsed.from);

  const absence = await prisma.absence.create({
    data: {
      employeeId: employee.id,
      companyId: employee.companyId,
      type: 'SONDERURLAUB',
      status: 'GEMELDET',
      startDate,
      endDate,
      durationDays: duration,
      note: parsed.rawText,
      sourceMessageId,
    },
  });

  await wa.sendMessage({
    to: fromPhone,
    text: `📋 Sonderurlaub / Pflegezeit erfasst. Dein Chef wurde benachrichtigt. (ID: ${absence.id.slice(-6)})`,
  });

  const inhaberPhone = await getInhaberPhone(employee.companyId);
  if (inhaberPhone && inhaberPhone !== fromPhone) {
    await wa.sendMessage({
      to: inhaberPhone,
      text: `📋 *Sonderurlaub:* ${employee.name} hat Sonderurlaub/Pflegezeit gemeldet. Bitte klären. (ID: ${absence.id.slice(-6)})`,
    });
  }
}
