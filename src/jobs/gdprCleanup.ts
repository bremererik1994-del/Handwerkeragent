import prisma from '../db';

// Message retention: WhatsApp message content older than 90 days is anonymized.
// The record stays for audit counts, but personal content is wiped.
const MESSAGE_RETAIN_DAYS = 90;

// Onboarding sessions older than 30 days without completion are stale and get deleted.
const ONBOARDING_SESSION_EXPIRE_DAYS = 30;

export async function runGdprCleanup() {
  const now = new Date();

  // 1. Hard-delete employees whose legal retention period has expired
  const dueEmployees = await prisma.employee.findMany({
    where: { deletedAt: { not: null }, retainUntil: { lte: now } },
    select: { id: true },
  });

  if (dueEmployees.length > 0) {
    await prisma.employee.deleteMany({
      where: { id: { in: dueEmployees.map((e) => e.id) } },
    });
    console.log(`[GDPR] ${dueEmployees.length} Mitarbeiterdatensätze endgültig gelöscht.`);
  }

  // 2. Anonymize WhatsApp message content older than 90 days
  const msgCutoff = new Date(now);
  msgCutoff.setDate(msgCutoff.getDate() - MESSAGE_RETAIN_DAYS);

  const { count: msgCount } = await prisma.whatsAppMessage.updateMany({
    where: {
      sentAt: { lte: msgCutoff },
      content: { not: '[gelöscht]' },
    },
    data: {
      content: '[gelöscht]',
      parsedData: null,
      mediaUrl: null,
    },
  });
  if (msgCount > 0) {
    console.log(`[GDPR] ${msgCount} WhatsApp-Nachrichteninhalte anonymisiert (>90 Tage).`);
  }

  // 3. Delete stale/incomplete onboarding sessions older than 30 days
  const sessionCutoff = new Date(now);
  sessionCutoff.setDate(sessionCutoff.getDate() - ONBOARDING_SESSION_EXPIRE_DAYS);

  const { count: sessionCount } = await prisma.companyOnboardingSession.deleteMany({
    where: {
      step: { not: 'DONE' },
      createdAt: { lte: sessionCutoff },
    },
  });
  if (sessionCount > 0) {
    console.log(`[GDPR] ${sessionCount} abgelaufene Onboarding-Sessions gelöscht.`);
  }
}

export function scheduleGdprCleanup() {
  runGdprCleanup().catch((err) => console.error('[GDPR] Cleanup-Fehler:', err));
  setInterval(() => {
    runGdprCleanup().catch((err) => console.error('[GDPR] Cleanup-Fehler:', err));
  }, 24 * 60 * 60 * 1000);
}
