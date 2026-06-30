import { startOfWeek, endOfWeek, startOfMonth, endOfMonth, isWeekend, format } from 'date-fns';
import { de } from 'date-fns/locale';
import prisma from '../../db';

// German public holidays 2024/2025 (federal – extend per Bundesland as needed)
const PUBLIC_HOLIDAYS = new Set([
  '2025-01-01', '2025-04-18', '2025-04-21', '2025-05-01',
  '2025-05-29', '2025-06-09', '2025-10-03', '2025-12-25', '2025-12-26',
]);

function isPublicHoliday(d: Date) {
  return PUBLIC_HOLIDAYS.has(format(d, 'yyyy-MM-dd'));
}

function isNightHour(d: Date) {
  const h = d.getHours();
  return h >= 23 || h < 6; // 23:00 – 06:00
}

export interface PayrollSummary {
  employeeId: string;
  employeeName: string;
  employmentType: string;
  periodFrom: string;
  periodTo: string;
  // Hours
  regularMinutes: number;
  overtimeMinutes: number;
  nightMinutes: number;
  sundayMinutes: number;
  holidayMinutes: number;
  totalWorkedMinutes: number;
  // Earnings (gross estimate)
  regularGross: number;
  overtimeGross: number;
  nightSurcharge: number;
  sundaySurcharge: number;
  holidaySurcharge: number;
  totalGross: number;
  // Absences (lohnrelevant)
  kranktage: number;
  urlaubstage: number;
  zeitausgleichtage: number;
  sonderurlaubtage: number;
  // Minijob warning
  minijobLimitWarning: boolean;
  minijobMonthlyLimit: number;
  disclaimer: string;
}

export async function generatePayrollSummary(
  companyId: string,
  employeeId: string,
  from: Date,
  to: Date,
): Promise<PayrollSummary> {
  const [employee, settings] = await Promise.all([
    prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      include: { company: { include: { settings: true } } },
    }),
    prisma.companySettings.findUnique({ where: { companyId } }),
  ]);

  const nightSurchargeRate = (settings?.nightSurchargeRate ?? 25) / 100;
  const sundaySurchargeRate = (settings?.sundaySurchargeRate ?? 50) / 100;
  const holidaySurchargeRate = (settings?.holidaySurchargeRate ?? 125) / 100;
  const overtimeThresholdWeek = settings?.overtimeThresholdWeek ?? 40;
  const hourlyRate = employee.hourlyRate ?? 0;

  const [entries, absences] = await Promise.all([prisma.timeEntry.findMany({
    where: {
      employeeId,
      status: { in: ['COMPLETED', 'CORRECTED'] },
      startTime: { gte: from },
      endTime: { lte: to },
    },
    orderBy: { startTime: 'asc' },
  }), prisma.absence.findMany({
    where: {
      employeeId,
      deletedAt: null,
      startDate: { gte: from },
      endDate: { lte: to },
    },
  })]);

  let regularMinutes = 0;
  let overtimeMinutes = 0;
  let nightMinutes = 0;
  let sundayMinutes = 0;
  let holidayMinutes = 0;

  // Group entries by week for overtime calculation
  const weeklyMinutes: Map<string, number> = new Map();

  for (const entry of entries) {
    const worked = entry.totalMinutes ?? 0;
    const start = entry.startTime;
    const weekKey = format(startOfWeek(start, { locale: de }), 'yyyy-MM-dd');

    weeklyMinutes.set(weekKey, (weeklyMinutes.get(weekKey) ?? 0) + worked);

    // Classify minutes (simplified: use start-of-shift day for classification)
    if (isPublicHoliday(start)) {
      holidayMinutes += worked;
    } else if (start.getDay() === 0) {
      // Sunday
      sundayMinutes += worked;
    }

    // Night hours (rough: if shift starts in night period)
    if (isNightHour(start)) {
      nightMinutes += Math.min(worked, 60); // conservative estimate
    }
  }

  // Overtime: minutes beyond threshold per week
  for (const [, weekMinutes] of weeklyMinutes) {
    const thresholdMinutes = overtimeThresholdWeek * 60;
    if (weekMinutes > thresholdMinutes) {
      overtimeMinutes += weekMinutes - thresholdMinutes;
      regularMinutes += thresholdMinutes;
    } else {
      regularMinutes += weekMinutes;
    }
  }

  const totalWorkedMinutes = regularMinutes + overtimeMinutes;
  const totalHours = totalWorkedMinutes / 60;
  const regularHours = regularMinutes / 60;
  const overtimeHours = overtimeMinutes / 60;
  const nightHours = nightMinutes / 60;
  const sundayHours = sundayMinutes / 60;
  const holidayHours = holidayMinutes / 60;

  const regularGross = regularHours * hourlyRate;
  const overtimeGross = overtimeHours * hourlyRate * 1.25; // 25% overtime premium
  const nightSurcharge = nightHours * hourlyRate * nightSurchargeRate;
  const sundaySurcharge = sundayHours * hourlyRate * sundaySurchargeRate;
  const holidaySurcharge = holidayHours * hourlyRate * holidaySurchargeRate;
  const totalGross = regularGross + overtimeGross + nightSurcharge + sundaySurcharge + holidaySurcharge;

  const minijobLimit = employee.monthlyEarningsLimit ?? settings?.minijobMonthlyLimit ?? 538;
  const minijobLimitWarning =
    employee.employmentType === 'MINIJOB' && totalGross > minijobLimit * 0.9;

  const kranktage = absences.filter((a) => a.type === 'KRANK').reduce((s, a) => s + a.durationDays, 0);
  const urlaubstage = absences.filter((a) => a.type === 'URLAUB').reduce((s, a) => s + a.durationDays, 0);
  const zeitausgleichtage = absences.filter((a) => a.type === 'ZEITAUSGLEICH').reduce((s, a) => s + a.durationDays, 0);
  const sonderurlaubtage = absences.filter((a) => a.type === 'SONDERURLAUB').reduce((s, a) => s + a.durationDays, 0);

  return {
    employeeId,
    employeeName: employee.name,
    employmentType: employee.employmentType,
    periodFrom: format(from, 'dd.MM.yyyy'),
    periodTo: format(to, 'dd.MM.yyyy'),
    regularMinutes,
    overtimeMinutes,
    nightMinutes,
    sundayMinutes,
    holidayMinutes,
    totalWorkedMinutes,
    regularGross,
    overtimeGross,
    nightSurcharge,
    sundaySurcharge,
    holidaySurcharge,
    totalGross,
    kranktage,
    urlaubstage,
    zeitausgleichtage,
    sonderurlaubtage,
    minijobLimitWarning,
    minijobMonthlyLimit: minijobLimit,
    disclaimer:
      'Dies ist eine Lohnvorbereitungs-Auswertung, KEINE rechtsverbindliche Lohnabrechnung. ' +
      'Die finale Prüfung und Verbuchung obliegt Ihrem Steuerberater / Lohnbuchhalter. ' +
      'Angaben ohne Gewähr.',
  };
}
