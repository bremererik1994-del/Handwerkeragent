import prisma from '../db';

// Löscht Mitarbeiterdatensätze (inkl. Zeiten/Abwesenheiten per Cascade) endgültig,
// sobald die gesetzliche Aufbewahrungsfrist (retainUntil) abgelaufen ist.
export async function runGdprCleanup() {
  const now = new Date();
  const due = await prisma.employee.findMany({
    where: { deletedAt: { not: null }, retainUntil: { lte: now } },
    select: { id: true },
  });

  if (due.length === 0) return;

  await prisma.employee.deleteMany({
    where: { id: { in: due.map((e) => e.id) } },
  });

  console.log(`[GDPR Cleanup] ${due.length} Mitarbeiterdatensätze endgültig gelöscht (Aufbewahrungsfrist abgelaufen).`);
}

export function scheduleGdprCleanup() {
  // einmal beim Start, danach täglich
  runGdprCleanup().catch((err) => console.error('[GDPR Cleanup] Fehler:', err));
  setInterval(() => {
    runGdprCleanup().catch((err) => console.error('[GDPR Cleanup] Fehler:', err));
  }, 24 * 60 * 60 * 1000);
}
