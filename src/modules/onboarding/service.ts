import prisma from '../../db';
import { getWhatsAppProvider } from '../whatsapp';
import type { ParsedMessage } from '../nlp/message.parser';
import type { Employee } from '@prisma/client';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_UNKNOWN_STREAK = 3;
const MAX_INVITE_REMINDERS = 2;
const INVITE_REMINDER_MS = 24 * 60 * 60 * 1000;
const MAX_PROCESSED_IDS = 20;

type EmployeeWithCompany = Employee & { company: { name: string; id: string } };

// ─── Session helpers ──────────────────────────────────────────────────────────

async function getOrCreateSession(employeeId: string) {
  return prisma.employeeOnboardingSession.upsert({
    where: { employeeId },
    create: { employeeId },
    update: {},
  });
}

async function patchSession(employeeId: string, data: Parameters<typeof prisma.employeeOnboardingSession.update>[0]['data']) {
  return prisma.employeeOnboardingSession.update({ where: { employeeId }, data });
}

// ─── Escalation ───────────────────────────────────────────────────────────────

export async function escalateToChef(employee: EmployeeWithCompany, reason: string) {
  const wa = getWhatsAppProvider();

  // Find the company owner (INHABER)
  const owner = await prisma.employee.findFirst({
    where: { companyId: employee.companyId, role: 'INHABER', deletedAt: null },
  });
  if (!owner) return;

  await wa.sendMessage({
    to: owner.phone,
    text:
      `⚠️ *Rapido-Hinweis* für ${employee.company.name}:\n\n` +
      `Mitarbeiter *${employee.name}* (${employee.phone}):\n${reason}\n\n` +
      `Bitte sprich ihn direkt an.`,
  });
}

// ─── Invite ───────────────────────────────────────────────────────────────────

export async function inviteEmployee(employeeId: string) {
  const employee = await prisma.employee.findUniqueOrThrow({
    where: { id: employeeId },
    include: { company: true },
  });

  const wa = getWhatsAppProvider();
  const firstName = employee.name.split(' ')[0];

  await wa.sendMessage({
    to: employee.phone,
    text:
      `Hallo ${firstName}! 👋\n\n` +
      `*${employee.company.name}* nutzt jetzt *Rapido* für die Zeiterfassung – ` +
      `komplett per WhatsApp, kein App-Download nötig.\n\n` +
      `Du buchst deine Zeiten einfach per Nachricht an diese Nummer.\n\n` +
      `Schreib *Ja*, um mitzumachen – oder *Nein*, falls du Fragen hast.`,
  });

  await prisma.employee.update({
    where: { id: employeeId },
    data: { onboardingState: 'INVITED' },
  });

  await getOrCreateSession(employeeId);
  scheduleInviteReminder(employeeId);
}

function scheduleInviteReminder(employeeId: string) {
  setTimeout(async () => {
    const session = await prisma.employeeOnboardingSession.findUnique({ where: { employeeId } });
    if (!session || session.step !== 'AWAIT_INVITE_CONFIRM') return;
    if (session.reminderCount >= MAX_INVITE_REMINDERS) {
      const emp = await prisma.employee.findUnique({ where: { id: employeeId }, include: { company: true } });
      if (emp) await escalateToChef(emp as EmployeeWithCompany, `Hat nach ${MAX_INVITE_REMINDERS + 1} Tagen die Einladung nicht angenommen.`);
      return;
    }

    const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!emp) return;
    const wa = getWhatsAppProvider();
    const firstName = emp.name.split(' ')[0];
    await wa.sendMessage({
      to: emp.phone,
      text:
        `Hallo ${firstName}! Kurze Erinnerung – du hast noch nicht auf deine Rapido-Einladung geantwortet.\n\n` +
        `Schreib *Ja* zum Annehmen oder *Nein* bei Fragen.`,
    });
    await patchSession(employeeId, {
      reminderCount: session.reminderCount + 1,
      lastReminderAt: new Date(),
    });

    // Schedule next reminder
    scheduleInviteReminder(employeeId);
  }, INVITE_REMINDER_MS);
}

// ─── Main handler for INVITED employees ──────────────────────────────────────

export async function handleInvitedEmployee(
  employee: EmployeeWithCompany,
  text: string,
  parsed: ParsedMessage,
  messageId: string,
  phone: string,
): Promise<void> {
  const wa = getWhatsAppProvider();
  const session = await getOrCreateSession(employee.id);
  const firstName = employee.name.split(' ')[0];

  // Idempotency
  if (session.processedIds.includes(messageId)) return;
  await patchSession(employee.id, {
    processedIds: [...session.processedIds.slice(-MAX_PROCESSED_IDS + 1), messageId],
  });

  // ── Implizite Annahme via Zeitbuchung ────────────────────────────────────────
  if (['START', 'END', 'DAY_ENTRY', 'BREAK', 'KRANK', 'URLAUB', 'ZEITAUSGLEICH'].includes(parsed.intent)) {
    await prisma.employee.update({
      where: { id: employee.id },
      data: { gdprConsent: true, gdprConsentAt: new Date(), onboardingState: 'OPTED_IN' },
    });
    await patchSession(employee.id, { step: 'AWAIT_FIRST_BOOKING', unknownStreak: 0 });
    await wa.sendMessage({
      to: phone,
      text: `Alles klar ${firstName}, ich hab dich angemeldet! ✅\nDeine Buchung wird jetzt verarbeitet…`,
    });
    // Dynamischer Import vermeidet zirkuläre Abhängigkeit
    const { handleTimeTrackingIntent } = await import('../timetracking/service');
    await handleTimeTrackingIntent(employee, parsed, messageId, phone, { beginnerMode: true });
    await completeFirstBooking(employee.id);
    return;
  }

  // ── Einladung annehmen ────────────────────────────────────────────────────────
  const isYes = /^(ja|j\b|ok|okay|jo|bin\s+dabei|passt|klar|gerne|👍|✓|✅|natürlich|kein\s+problem|einverstanden)/i.test(text.trim());
  if (parsed.intent === 'ONBOARDING_OPT_IN' || isYes) {
    await acceptInvite(employee, phone);
    return;
  }

  // ── Ablehnung / Verwirrung ────────────────────────────────────────────────────
  const isNo = /^(nein|n\b|nö|stop|abmelden|ablehnen|falsche\s+nummer|wer\s+ist|nicht\s+angefragt|kenn\s+ich\s+nicht)/i.test(text.trim().toLowerCase());
  if (parsed.intent === 'ONBOARDING_OPT_OUT' || isNo) {
    await handleInviteRejection(employee, phone, text);
    return;
  }

  // ── Unklare Nachricht ─────────────────────────────────────────────────────────
  const streak = session.unknownStreak + 1;
  await patchSession(employee.id, { unknownStreak: streak });

  if (streak >= MAX_UNKNOWN_STREAK) {
    await escalateToChef(employee, `Hat 3x nicht verständlich auf die Einladung reagiert. Letzte Nachricht: "${text}"`);
    await wa.sendMessage({
      to: phone,
      text:
        `Ich konnte nicht weiterhelfen 🙁\n\n` +
        `Dein Chef wurde informiert. Bei Fragen wende dich direkt an *${employee.company.name}*.`,
    });
    return;
  }

  await wa.sendMessage({
    to: phone,
    text:
      `Kurze Erklärung: *${employee.company.name}* hat dich zur digitalen Zeiterfassung eingeladen.\n\n` +
      `Schreib *Ja* zum Mitmachen oder *Nein* bei Fragen.`,
  });
}

async function acceptInvite(employee: EmployeeWithCompany, phone: string) {
  const wa = getWhatsAppProvider();
  const hasPrefilledName = employee.name && employee.name.trim().length > 1;

  await prisma.employee.update({
    where: { id: employee.id },
    data: { gdprConsent: true, gdprConsentAt: new Date(), onboardingState: 'OPTED_IN' },
  });

  if (hasPrefilledName) {
    await patchSession(employee.id, { step: 'AWAIT_NAME_CONFIRM', unknownStreak: 0 });
    await wa.sendMessage({
      to: phone,
      text: `Super! 👍\n\nDein Chef hat dich als *${employee.name}* eingetragen – bist du das?`,
    });
  } else {
    await patchSession(employee.id, { step: 'AWAIT_NAME_INPUT', unknownStreak: 0 });
    await wa.sendMessage({
      to: phone,
      text: `Super, schön dass du dabei bist! 👍\n\nWie heißt du? (Vor- und Nachname)`,
    });
  }
}

async function handleInviteRejection(employee: EmployeeWithCompany, phone: string, text: string) {
  const wa = getWhatsAppProvider();
  await escalateToChef(employee, `Hat die Einladung abgelehnt oder meldet falsche Nummer. Nachricht: "${text}"`);
  await wa.sendMessage({
    to: phone,
    text:
      `Kein Problem – du wirst keine weiteren Nachrichten von uns erhalten.\n\n` +
      `Falls es sich um eine falsche Nummer handelt, wurde dein Chef informiert.`,
  });
}

// ─── Handler für OPTED_IN (nach Einladungsannahme) ────────────────────────────

export async function handleOptedInEmployee(
  employee: EmployeeWithCompany,
  text: string,
  parsed: ParsedMessage,
  messageId: string,
  phone: string,
): Promise<void> {
  const wa = getWhatsAppProvider();
  const session = await getOrCreateSession(employee.id);

  // Idempotency
  if (session.processedIds.includes(messageId)) return;
  await patchSession(employee.id, {
    processedIds: [...session.processedIds.slice(-MAX_PROCESSED_IDS + 1), messageId],
  });

  // ── AWAIT_NAME_CONFIRM ─────────────────────────────────────────────────────
  if (session.step === 'AWAIT_NAME_CONFIRM') {
    await handleNameConfirm(employee, text, phone);
    return;
  }

  // ── AWAIT_NAME_INPUT ──────────────────────────────────────────────────────
  if (session.step === 'AWAIT_NAME_INPUT') {
    await handleNameInput(employee, text, phone);
    return;
  }

  // ── AWAIT_FIRST_BOOKING oder normale Zeiterfassung ────────────────────────
  const isTimeEntry = ['START', 'END', 'DAY_ENTRY', 'BREAK', 'KRANK', 'URLAUB', 'ZEITAUSGLEICH', 'SONDERURLAUB'].includes(parsed.intent);
  const isRetroactive = parsed.intent === 'RETROACTIVE';
  const isQuery = parsed.intent === 'QUERY_HOURS';

  if (isTimeEntry || isRetroactive) {
    const { handleTimeTrackingIntent } = await import('../timetracking/service');
    const beginnerMode = session.step === 'AWAIT_FIRST_BOOKING';
    await handleTimeTrackingIntent(employee, parsed, messageId, phone, { beginnerMode });
    if (beginnerMode) {
      await completeFirstBooking(employee.id);
    } else {
      // Reset unknown streak on successful booking
      await patchSession(employee.id, { unknownStreak: 0 });
    }
    return;
  }

  if (isQuery) {
    await handleQueryHours(employee, phone);
    return;
  }

  // ── UNKNOWN ────────────────────────────────────────────────────────────────
  const streak = session.unknownStreak + 1;
  await patchSession(employee.id, { unknownStreak: streak });

  const beginnerHint = session.step === 'AWAIT_FIRST_BOOKING'
    ? `\n\n_Für die erste Buchung einfach schreiben:_ *Start 08:00* _(wenn du anfängst)_`
    : '';

  const helpText =
    `🤔 Das habe ich nicht verstanden.\n\n` +
    `So funktioniert's:\n` +
    `▶️ *Start 08:00* – Schicht starten\n` +
    `⏹ *Ende* – Schicht beenden\n` +
    `📅 *08:00–17:00* – ganzen Tag auf einmal buchen\n` +
    `🤒 *Krank* – Krankmeldung\n` +
    `🏖 *Urlaub* – Urlaubsantrag` +
    beginnerHint;

  if (streak >= MAX_UNKNOWN_STREAK) {
    await escalateToChef(employee, `${employee.name} hat ${streak}x eine unverständliche Nachricht geschickt. Letzte: "${text}"`);
    await wa.sendMessage({
      to: phone,
      text:
        `${helpText}\n\n` +
        `Wenn du trotzdem nicht weiterkommst, sprich direkt mit deinem Chef.`,
    });
    await patchSession(employee.id, { unknownStreak: 0 }); // Reset nach Eskalation
    return;
  }

  await wa.sendMessage({ to: phone, text: helpText });
}

async function handleNameConfirm(employee: EmployeeWithCompany, text: string, phone: string) {
  const wa = getWhatsAppProvider();
  const t = text.trim().toLowerCase();
  const isYes = /^(ja|j\b|ok|okay|ja\s+bin\s+ich|ja\s+das\s+bin\s+ich|stimmt|genau|👍)/i.test(t);
  const isNo = /^(nein|n\b|nö|nicht|falsch|ich\s+bin\s+(nicht|kein))/i.test(t);

  if (isYes) {
    await patchSession(employee.id, { step: 'AWAIT_FIRST_BOOKING', unknownStreak: 0 });
    await sendFirstBookingInstructions(phone, employee.name.split(' ')[0]);
    return;
  }

  if (isNo) {
    // Vielleicht steckt der richtige Name in der Antwort
    const nameMatch = text.match(/(?:ich\s+bin|bin|heiße?|name\s+ist)?\s+([A-ZÄÖÜ][a-zäöüß\-]{1,20}(?:\s+[A-ZÄÖÜ][a-zäöüß\-]{1,20})?)/);
    if (nameMatch) {
      const newName = nameMatch[1].trim();
      await prisma.employee.update({ where: { id: employee.id }, data: { name: newName } });
      await escalateToChef(employee, `Name wurde korrigiert: "${employee.name}" → "${newName}"`);
      await patchSession(employee.id, { step: 'AWAIT_FIRST_BOOKING', unknownStreak: 0 });
      await wa.sendMessage({
        to: phone,
        text: `Danke, ich hab das korrigiert: *${newName}* ✅`,
      });
      await sendFirstBookingInstructions(phone, newName.split(' ')[0]);
    } else {
      await wa.sendMessage({ to: phone, text: `Kein Problem – wie heißt du richtig?` });
      await patchSession(employee.id, { step: 'AWAIT_NAME_INPUT' });
    }
    return;
  }

  // Unklar
  await wa.sendMessage({
    to: phone,
    text: `Bist du *${employee.name}*? Schreib *Ja* oder nenn mir deinen richtigen Namen.`,
  });
}

async function handleNameInput(employee: EmployeeWithCompany, text: string, phone: string) {
  const wa = getWhatsAppProvider();
  const t = text.trim();

  // Einfachste Heuristik: alles außer reinen Stoppwörtern als Name akzeptieren
  const SKIP = new Set(['ich', 'bin', 'heiße', 'heisse', 'mein', 'name', 'ist', 'hallo', 'ja', 'nein', 'ok']);
  const words = t.split(/[\s,]+/).filter(w => w.length > 1 && !SKIP.has(w.toLowerCase()));

  if (words.length === 0) {
    await wa.sendMessage({ to: phone, text: `Bitte schreib deinen Namen (Vorname reicht).` });
    return;
  }

  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  const name = words.slice(0, 2).map(cap).join(' ');

  await prisma.employee.update({ where: { id: employee.id }, data: { name } });
  await patchSession(employee.id, { step: 'AWAIT_FIRST_BOOKING', unknownStreak: 0 });
  await wa.sendMessage({ to: phone, text: `Schön, *${name}*! 👋` });
  await sendFirstBookingInstructions(phone, name.split(' ')[0]);
}

async function sendFirstBookingInstructions(phone: string, firstName: string) {
  const wa = getWhatsAppProvider();
  await wa.sendMessage({
    to: phone,
    text:
      `So funktioniert Rapido, ${firstName}:\n\n` +
      `▶️ *Start 08:00* – wenn du anfängst\n` +
      `⏹ *Ende* – wenn du Feierabend machst\n` +
      `📅 *08:00–17:00* – den ganzen Tag auf einmal (z.B. abends)\n` +
      `🤒 *Krank* – Krankmeldung\n` +
      `🏖 *Urlaub* – Urlaubsantrag\n\n` +
      `Probier's direkt aus – schick mir *Start* + Uhrzeit! 👇`,
  });
}

export async function completeFirstBooking(employeeId: string) {
  const session = await prisma.employeeOnboardingSession.findUnique({ where: { employeeId } });
  if (session?.step !== 'AWAIT_FIRST_BOOKING') return;

  await prisma.employee.update({
    where: { id: employeeId },
    data: { onboardingState: 'ACTIVE' },
  });
  await patchSession(employeeId, { step: 'DONE', unknownStreak: 0 });
}

// ─── Stunden-Anfrage ──────────────────────────────────────────────────────────

async function handleQueryHours(employee: Employee, phone: string) {
  const wa = getWhatsAppProvider();

  const startOfWeek = new Date();
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay() + 1);
  startOfWeek.setHours(0, 0, 0, 0);

  const entries = await prisma.timeEntry.findMany({
    where: {
      employeeId: employee.id,
      status: 'COMPLETED',
      startTime: { gte: startOfWeek },
    },
  });

  const totalMin = entries.reduce((s, e) => s + (e.totalMinutes ?? 0), 0);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;

  if (totalMin === 0) {
    await wa.sendMessage({ to: phone, text: `Diese Woche habe ich noch keine Buchungen von dir. Schreib *Start HH:MM* wenn du anfängst.` });
  } else {
    await wa.sendMessage({
      to: phone,
      text: `📊 Diese Woche: *${hours}h ${mins}min* über ${entries.length} Schicht${entries.length !== 1 ? 'en' : ''}.`,
    });
  }
}

// ─── Legacy: handleOnboardingIntent (bleibt für Rückwärtskompatibilität) ──────

export async function handleOnboardingIntent(
  employee: Employee & { company: { name: string; id: string } },
  parsed: ParsedMessage,
  _sourceMessageId: string,
) {
  const wa = getWhatsAppProvider();

  if (parsed.intent === 'ONBOARDING_OPT_OUT') {
    await prisma.employee.update({
      where: { id: employee.id },
      data: { gdprConsent: false, onboardingState: 'INVITED' },
    });
    await wa.sendMessage({
      to: employee.phone,
      text: 'Deine Einwilligung wurde widerrufen. Du erhältst keine weiteren Nachrichten. Schreib "Ja" um wieder mitzumachen.',
    });
  }
}

export async function markEmployeeActive(employeeId: string) {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (emp && (emp.onboardingState === 'OPTED_IN' || emp.onboardingState === 'TRAINED')) {
    await prisma.employee.update({
      where: { id: employeeId },
      data: { onboardingState: 'ACTIVE' },
    });
  }
}
