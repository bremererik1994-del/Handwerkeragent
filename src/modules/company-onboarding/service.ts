import prisma from '../../db';
import { getWhatsAppProvider } from '../whatsapp/index';
import { extractOnboardingData, ExtractionResult, Intent } from './extraction';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_FAILURES_PER_FIELD = 3;
const RESUME_THRESHOLD_MS = 60 * 60 * 1000; // 1 Stunde
const MAX_PROCESSED_IDS = 30; // Idempotenz-Buffer
const CONFIDENCE_APPLY = 0.70; // Mindest-Confidence für Übernahme

// ─── Types ────────────────────────────────────────────────────────────────────

interface WaContact {
  name: { formatted_name: string; first_name?: string; last_name?: string };
  phones: Array<{ phone: string; type?: string }>;
}

interface TempData {
  // Onboarding-Daten
  ownerFirstName?: string;
  ownerLastName?: string;
  companyName?: string;
  employeeCount?: number;
  employeeCountIsRange?: boolean;
  employeeCountMin?: number;
  employeeCountMax?: number;
  autoReminder?: boolean;
  reminderTime?: string;
  stundenzettel?: boolean;
  baustelle?: boolean;

  // State-Machine-Metadaten
  failureCounts?: Record<string, number>;
  processedMsgIds?: string[];
  pendingRangeField?: string;
  pendingRangeMin?: number;
  pendingRangeMax?: number;
  [key: string]: unknown;
}

type MissingField =
  | 'name' | 'companyName'
  | 'employeeCount' | 'reminder' | 'stundenzettel' | 'baustelle';

// ─── Field Logic ──────────────────────────────────────────────────────────────

function getNextMissingField(temp: TempData): MissingField | null {
  if (!temp.ownerFirstName || !temp.ownerLastName) return 'name';
  if (!temp.companyName) return 'companyName';
  if (temp.employeeCount == null) return 'employeeCount';
  if (temp.autoReminder === undefined) return 'reminder';
  if (temp.stundenzettel === undefined) return 'stundenzettel';
  if (temp.baustelle === undefined) return 'baustelle';
  return null; // alle Felder gesammelt → weiter zu DSGVO
}

function getCollectedFields(temp: TempData): string[] {
  const collected: string[] = [];
  if (temp.ownerFirstName) collected.push('ownerFirstName');
  if (temp.ownerLastName) collected.push('ownerLastName');
  if (temp.companyName) collected.push('companyName');
  if (temp.employeeCount != null) collected.push('employeeCount');
  if (temp.autoReminder !== undefined) collected.push('autoReminder');
  if (temp.stundenzettel !== undefined) collected.push('stundenzettel');
  if (temp.baustelle !== undefined) collected.push('baustelle');
  return collected;
}

function buildQuestion(field: MissingField, temp: TempData): string {
  switch (field) {
    case 'name':
      if (temp.ownerFirstName && !temp.ownerLastName)
        return `Und dein Nachname, ${temp.ownerFirstName}?`;
      return `Wie heißt du? Bitte schreib Vor- und Nachname.`;

    case 'companyName':
      return `Wie heißt dein Betrieb?`;

    case 'employeeCount':
      return `Wie viele Mitarbeiter hat dein Betrieb?`;

    case 'reminder':
      return (
        `Wir erinnern deine Mitarbeiter täglich um 18:00 Uhr, wenn eine Zeitbuchung fehlt.\n\n` +
        `Wenn du eine andere Uhrzeit möchtest, nenn sie mir einfach. ` +
        `Oder schreib *Nein*, um die automatische Erinnerung zu deaktivieren.`
      );

    case 'stundenzettel': {
      const reminderInfo = temp.autoReminder
        ? `Erinnerungen gehen täglich um ${temp.reminderTime} Uhr raus.`
        : `Automatische Erinnerungen sind deaktiviert.`;
      return (
        `${reminderInfo}\n\n` +
        `Unterschreiben eure Kunden Stundenzettel als Nachweis? Dann kann dein Mitarbeiter das Dokument ` +
        `direkt per WhatsApp als Foto einschicken – Rapido speichert es automatisch und du kannst es jederzeit abrufen.\n\n` +
        `Ja oder Nein?`
      );
    }

    case 'baustelle':
      return (
        `Möchtest du auch das Baustellenmanagement aktivieren?\n\n` +
        `Deine Mitarbeiter nennen bei jeder Buchung die Baustelle – du siehst jederzeit, wer wo arbeitet. ` +
        `Das ist außerdem die Grundlage für weitere Funktionen wie Baustellenberichte und Auswertungen je Projekt.\n\n` +
        `Ja oder Nein?`
      );
  }
}

function buildRecapAndQuestion(temp: TempData, nextField: MissingField): string {
  const parts: string[] = [];
  if (temp.ownerFirstName) parts.push(`Name: ${temp.ownerFirstName} ${temp.ownerLastName ?? ''}`.trim());
  if (temp.companyName) parts.push(`Betrieb: ${temp.companyName}`);
  if (temp.employeeCount != null) parts.push(`Mitarbeiter: ${temp.employeeCount}`);

  const recap = parts.length > 0
    ? `Kurze Zusammenfassung – wir waren hier:\n${parts.map(p => `• ${p}`).join('\n')}\n\n`
    : '';
  return `${recap}Weiter geht's! ${buildQuestion(nextField, temp)}`;
}

// ─── Answer Short FAQ ─────────────────────────────────────────────────────────

function answerFAQ(question: string): string | null {
  const q = question.toLowerCase();
  if (/daten|datenschutz|warum.*name|wieso.*nummer/.test(q))
    return `Deine Daten (Name, Handynummer, Zeitbuchungen) werden ausschließlich für die Zeiterfassung genutzt – kein Verkauf, kein Drittanbieter. Volle Details: rapido-handwerk.net/datenschutz`;
  if (/kost|preis|gratis|kostenlos|bezahl/.test(q))
    return `In der Beta-Phase ist Rapido kostenlos. Danach kommt ein fairer Monatsbeitrag – du wirst rechtzeitig informiert.`;
  if (/mitarbeiter|ma\b|how many|wieviel.*leute/.test(q))
    return `Gemeint ist die Anzahl deiner Mitarbeiter, die ihre Arbeitszeiten über Rapido erfassen sollen.`;
  if (/stundenzett/.test(q))
    return `Wenn Kunden eure geleisteten Stunden auf einem Zettel bestätigen, kann das als Foto per WhatsApp eingeschickt werden – Rapido speichert es automatisch.`;
  if (/baustell/.test(q))
    return `Das Baustellenmanagement erlaubt es, jede Zeitbuchung einer Baustelle zuzuordnen. So siehst du jederzeit, wer wo arbeitet.`;
  return null;
}

// ─── Apply Extracted Fields ───────────────────────────────────────────────────

function applyExtraction(temp: TempData, extraction: ExtractionResult): {
  updated: TempData;
  skippedFields: string[];
} {
  const updated = { ...temp };
  const skipped: string[] = [];

  const { fields } = extraction;

  if (fields.ownerFirstName && fields.ownerFirstName.confidence >= CONFIDENCE_APPLY)
    updated.ownerFirstName = fields.ownerFirstName.value;
  if (fields.ownerLastName && fields.ownerLastName.confidence >= CONFIDENCE_APPLY)
    updated.ownerLastName = fields.ownerLastName.value;
  if (fields.companyName && fields.companyName.confidence >= CONFIDENCE_APPLY)
    updated.companyName = fields.companyName.value;
  if (fields.employeeCount && fields.employeeCount.confidence >= CONFIDENCE_APPLY) {
    if (fields.employeeCount.isRange) {
      updated.pendingRangeField = 'employeeCount';
      updated.pendingRangeMin = fields.employeeCount.rangeMin;
      updated.pendingRangeMax = fields.employeeCount.rangeMax;
    } else {
      updated.employeeCount = fields.employeeCount.value;
    }
  }
  if (fields.autoReminder && fields.autoReminder.confidence >= CONFIDENCE_APPLY)
    updated.autoReminder = fields.autoReminder.value;
  if (fields.reminderTime && fields.reminderTime.confidence >= CONFIDENCE_APPLY)
    updated.reminderTime = fields.reminderTime.value;
  if (fields.stundenzettel && fields.stundenzettel.confidence >= CONFIDENCE_APPLY)
    updated.stundenzettel = fields.stundenzettel.value;
  if (fields.baustelle && fields.baustelle.confidence >= CONFIDENCE_APPLY)
    updated.baustelle = fields.baustelle.value;

  return { updated, skippedFields: skipped };
}

// ─── Confirmation Snippets ────────────────────────────────────────────────────

function buildSkipConfirmations(before: TempData, after: TempData): string[] {
  const msgs: string[] = [];
  if (before.employeeCount == null && after.employeeCount != null)
    msgs.push(`${after.employeeCount} Mitarbeiter – notiert ✅`);
  if (before.autoReminder === undefined && after.autoReminder !== undefined) {
    if (after.autoReminder) msgs.push(`Erinnerungen um ${after.reminderTime ?? '18:00'} Uhr – notiert ✅`);
    else msgs.push(`Keine automatischen Erinnerungen – notiert ✅`);
  }
  return msgs;
}

// ─── Session Helpers ──────────────────────────────────────────────────────────

function addProcessedId(temp: TempData, msgId: string): TempData {
  const ids = [...(temp.processedMsgIds ?? []), msgId].slice(-MAX_PROCESSED_IDS);
  return { ...temp, processedMsgIds: ids };
}

function incrementFailure(temp: TempData, field: string): TempData {
  const counts = { ...(temp.failureCounts ?? {}), [field]: ((temp.failureCounts ?? {})[field] ?? 0) + 1 };
  return { ...temp, failureCounts: counts };
}

function resetFailure(temp: TempData, field: string): TempData {
  const counts = { ...(temp.failureCounts ?? {}) };
  delete counts[field];
  return { ...temp, failureCounts: counts };
}

function getFailureCount(temp: TempData, field: string): number {
  return (temp.failureCounts ?? {})[field] ?? 0;
}

// ─── DB Persistence ───────────────────────────────────────────────────────────

async function saveSession(phone: string, step: string, temp: TempData) {
  await prisma.companyOnboardingSession.update({
    where: { phone },
    data: { step, tempData: temp as unknown as import('@prisma/client').Prisma.InputJsonValue },
  });
}

// ─── Finish Onboarding ────────────────────────────────────────────────────────

async function finishOnboarding(phone: string, temp: TempData): Promise<void> {
  const wa = getWhatsAppProvider();
  const ownerName = `${temp.ownerFirstName ?? ''} ${temp.ownerLastName ?? ''}`.trim();

  const company = await prisma.company.create({
    data: {
      name: temp.companyName ?? ownerName,
      industry: 'HANDWERK',
      settings: {
        create: {
          overtimeThresholdWeek: 40,
          sundaySurchargeRate: 100,
        },
      },
      employees: {
        create: {
          name: ownerName,
          phone,
          role: 'INHABER',
          employmentType: 'VOLLZEIT',
          onboardingState: 'ACTIVE',
          gdprConsent: true,
          gdprConsentAt: new Date(),
        },
      },
    },
    include: { employees: true },
  });

  await saveSession(phone, 'AWAIT_EMPLOYEE_NUMBERS', temp);

  const extras: string[] = [];
  if (temp.autoReminder) extras.push(`⏰ Erinnerung täglich um ${temp.reminderTime ?? '18:00'} Uhr`);
  if (temp.stundenzettel) extras.push(`📋 Stundenzettel: aktiv`);
  if (temp.baustelle) extras.push(`🏗 Baustellenmonitoring: aktiv`);

  await wa.sendMessage({
    to: phone,
    text:
      `🎉 *${company.name} ist jetzt bei Rapido eingerichtet!*\n\n` +
      `👥 ${temp.employeeCount ?? '–'} Mitarbeiter\n` +
      (extras.length ? extras.join('\n') + '\n' : '') +
      `\n_Einwilligung widerrufen: "Datenschutz löschen"_`,
  });

  const leistungen = temp.baustelle
    ? `die digitale *Zeiterfassung und das Baustellenmonitoring*`
    : `die digitale *Zeiterfassung*`;

  const stundenzettelHinweis = temp.stundenzettel
    ? `\n\nWenn ihr einen Stundenzettel vom Kunden unterschrieben bekommt, schickt das Dokument bitte als Foto per WhatsApp an diese Nummer – mit einem kurzen Kommentar zur Baustelle, damit es richtig zugeordnet wird.`
    : '';

  await wa.sendMessage({
    to: phone,
    text:
      `——————————————\n` +
      `*${company.name}* nutzt ab sofort Rapido für ${leistungen} – komplett per WhatsApp, kein App-Download, kein Papierkram.\n\n` +
      `Schreib einmal *Ja* an diese Nummer und du bist dabei:\n\n` +
      `📱 *+49 XXX XXXXXXX*` +
      stundenzettelHinweis +
      `\n\n– ${ownerName}\n——————————————`,
  });

  await wa.sendMessage({
    to: phone,
    text:
      `Schick mir jetzt einfach die Kontakte deiner Mitarbeiter direkt in den Chat – ich erstelle die Profile und zeige dir danach deine personalisierte Übersichtsseite, die du jederzeit aufrufen kannst.\n\n` +
      `Wenn du fertig bist, schreib *Fertig*.`,
  });
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export async function handleCompanyOnboarding(
  phone: string,
  text: string,
  options?: { messageId?: string; messageType?: string; contacts?: WaContact[] },
): Promise<boolean> {
  const wa = getWhatsAppProvider();
  const normalized = phone.startsWith('+') ? phone : '+' + phone;
  const input = text.trim();
  const lower = input.toLowerCase();
  const messageId = options?.messageId;
  const messageType = options?.messageType ?? 'text';

  // ── Erste Nachricht: Session anlegen ─────────────────────────────────────────
  let session = await prisma.companyOnboardingSession.findUnique({ where: { phone: normalized } });

  if (!session) {
    const initTemp: TempData = { processedMsgIds: messageId ? [messageId] : [] };
    session = await prisma.companyOnboardingSession.create({
      data: {
        phone: normalized,
        step: 'COLLECTING',
        tempData: initTemp as unknown as import('@prisma/client').Prisma.InputJsonValue,
      },
    });

    // Extraktion aus der ersten Nachricht – vielleicht steckt schon was drin
    const firstExtraction = await extractOnboardingData(input, {
      currentStep: 'COLLECTING',
      collectedFields: [],
      messageType,
    });
    let temp = initTemp;
    if (firstExtraction.intent === 'PROVIDE_INFO' || firstExtraction.intent === 'CORRECTION') {
      const { updated } = applyExtraction(temp, firstExtraction);
      temp = updated;
    }
    await saveSession(normalized, 'COLLECTING', temp);

    const nextField = getNextMissingField(temp) ?? 'name';
    await wa.sendMessage({
      to: normalized,
      text:
        `👋 Willkommen bei *Rapido*!\n\n` +
        `Ich bin dein digitaler Assistent für Zeiterfassung per WhatsApp – kein App-Download, kein Papierkram. ` +
        `Deine Mitarbeiter schicken einfach eine Nachricht, wenn sie anfangen oder aufhören. Das war's.`,
    });
    await wa.sendMessage({ to: normalized, text: buildQuestion(nextField as MissingField, temp) });
    return true;
  }

  let temp = (session.tempData ?? {}) as TempData;

  // ── Idempotenz: Doppelte Nachrichten ignorieren ───────────────────────────────
  if (messageId && (temp.processedMsgIds ?? []).includes(messageId)) {
    console.info('[onboarding] duplicate messageId, skipping:', messageId);
    return true;
  }
  temp = messageId ? addProcessedId(temp, messageId) : temp;

  // ── DONE: Session aufräumen ───────────────────────────────────────────────────
  if (session.step === 'DONE') {
    await prisma.companyOnboardingSession.delete({ where: { phone: normalized } });
    return false;
  }

  // ── AWAIT_EMPLOYEE_NUMBERS: Kontakte verarbeiten ──────────────────────────────
  if (session.step === 'AWAIT_EMPLOYEE_NUMBERS') {
    const wa = getWhatsAppProvider();
    const contacts = options?.contacts ?? [];

    // "Fertig" → Dashboard-Link schicken + Session schließen
    if (/^(fertig|done|abschließen|abschluss|beenden|weiter|ok|okay)$/i.test(input)) {
      const company = await prisma.company.findFirst({
        where: { employees: { some: { phone: normalized, role: 'INHABER' } } },
        select: { dashboardToken: true },
      });
      await prisma.companyOnboardingSession.delete({ where: { phone: normalized } });
      await wa.sendMessage({
        to: normalized,
        text: `Alles erledigt! ✅ Deine Mitarbeiter erhalten in Kürze ihre Einladung.\n\nHier ist deine persönliche Übersichtsseite – nur für dich:\n\n🔗 https://rapido-handwerk.net/view/${company?.dashboardToken ?? ''}\n\nDort siehst du alle Stunden, Abwesenheiten und Baustellen in Echtzeit und kannst Einträge korrigieren sowie CSV-Exporte herunterladen.`,
      });
      return true;
    }

    if (contacts.length === 0) {
      await wa.sendMessage({
        to: normalized,
        text:
          `Schick mir die Kontakte deiner Mitarbeiter direkt aus deinem Telefonbuch – ` +
          `einfach den Kontakt antippen und weiterleiten.\n\nWenn alle dabei sind, schreib *Fertig*.`,
      });
      return true;
    }

    // Kontakte verarbeiten
    const { inviteEmployee } = await import('../onboarding/service');
    const company = await prisma.company.findFirst({
      where: { employees: { some: { phone: normalized, role: 'INHABER' } } },
    });
    if (!company) return true;

    const confirmations: string[] = [];
    for (const contact of contacts) {
      const contactPhone = normalizeContactPhone(contact.phones[0]?.phone ?? '');
      if (!contactPhone) continue;

      const name = contact.name.formatted_name.trim();

      // Duplikat-Check
      const exists = await prisma.employee.findFirst({
        where: { phone: contactPhone, companyId: company.id, deletedAt: null },
      });
      if (exists) {
        confirmations.push(`⚠️ *${name}* ist bereits im System`);
        continue;
      }

      const emp = await prisma.employee.create({
        data: {
          name,
          phone: contactPhone,
          companyId: company.id,
          role: 'MITARBEITER',
          employmentType: 'VOLLZEIT',
          onboardingState: 'INVITED',
          gdprConsent: false,
        },
      });

      await inviteEmployee(emp.id);
      confirmations.push(`✅ *${name}* eingeladen`);
    }

    await wa.sendMessage({
      to: normalized,
      text:
        confirmations.join('\n') +
        `\n\nNoch weitere Mitarbeiter? Einfach Kontakt schicken – oder schreib *Fertig*.`,
    });

    await saveSession(normalized, 'AWAIT_EMPLOYEE_NUMBERS', temp);
    return true;
  }

  // ── Nicht-Text-Nachrichten ────────────────────────────────────────────────────
  if (messageType !== 'text' || (!input && messageType !== 'text')) {
    const typeLabel =
      messageType === 'audio' ? 'Sprachnachricht' :
      messageType === 'image' ? 'Bild' :
      messageType === 'document' ? 'Dokument' : 'Datei';
    await wa.sendMessage({
      to: normalized,
      text:
        `Ich kann ${typeLabel}en im Onboarding leider noch nicht auswerten 🙏\n\n` +
        `Bitte schreib deine Antwort einfach als Text.`,
    });
    await saveSession(normalized, session.step, temp);
    return true;
  }

  // ── RESTART-Signal ────────────────────────────────────────────────────────────
  if (/\b(nochmal\s+von\s+vorne|von\s+vorne|neustart|neu\s+starten|nochmal\s+starten)\b/i.test(lower)) {
    await prisma.companyOnboardingSession.delete({ where: { phone: normalized } });
    await wa.sendMessage({
      to: normalized,
      text: `Kein Problem, wir fangen von vorne an! Schreib mir einfach nochmal "Hallo" wenn du bereit bist. 👋`,
    });
    return true;
  }

  // ── STOP-Signal ───────────────────────────────────────────────────────────────
  if (/^(stop|abbrechen|cancel|aufhören|abbr\.?)$/i.test(lower)) {
    await prisma.companyOnboardingSession.delete({ where: { phone: normalized } });
    await wa.sendMessage({
      to: normalized,
      text: `Alles klar, der Vorgang wurde abgebrochen. Wenn du später doch starten möchtest, schreib einfach nochmal. 👋`,
    });
    return true;
  }

  // ── AWAIT_CONSENT: DSGVO-Abschluss ───────────────────────────────────────────
  if (session.step === 'AWAIT_CONSENT') {
    // Korrektur mitten in der DSGVO-Abfrage → zurück zu COLLECTING
    const CORRECTION_TRIGGER = /korrigier|falsch|stimmt nicht|ich mein|nein.*mitarbeiter|nein.*name|nein.*betrieb|ändere?n|doch.*nicht/i.test(lower);
    if (CORRECTION_TRIGGER) {
      const extraction = await extractOnboardingData(input, { currentStep: 'COLLECTING', collectedFields: getCollectedFields(temp), messageType });
      if (extraction.intent === 'CORRECTION' || extraction.intent === 'PROVIDE_INFO') {
        const before = { ...temp };
        const { updated } = applyExtraction(temp, extraction);
        temp = updated;
        const correctedFields: string[] = [];
        if (before.ownerFirstName !== temp.ownerFirstName || before.ownerLastName !== temp.ownerLastName)
          correctedFields.push(`Name: *${temp.ownerFirstName} ${temp.ownerLastName}*`);
        if (before.companyName !== temp.companyName) correctedFields.push(`Betrieb: *${temp.companyName}*`);
        if (before.employeeCount !== temp.employeeCount) correctedFields.push(`Mitarbeiter: *${temp.employeeCount}*`);
        if (correctedFields.length > 0) {
          await wa.sendMessage({ to: normalized, text: `Alles klar, korrigiert:\n${correctedFields.join('\n')} ✅` });
        }
        await saveSession(normalized, 'COLLECTING', temp);
        await sendDsgvoRequest(normalized, temp);
        return true;
      }
      // Fallthrough to regular AWAIT_CONSENT handling
    }

    const YES = /^(ja|j|ok|okay|stimmt|einverstanden|akzeptiere|👍|✓|✅)/i.test(input);
    const NO  = /^(nein|n|nö|ablehnen|nicht|👎|❌)/i.test(input);

    if (NO) {
      await prisma.companyOnboardingSession.delete({ where: { phone: normalized } });
      await wa.sendMessage({
        to: normalized,
        text: `Kein Problem. Ohne Einwilligung werden keine Daten gespeichert. Du kannst jederzeit neu starten. 👋`,
      });
      return true;
    }

    if (!YES) {
      temp = incrementFailure(temp, 'consent');
      if (getFailureCount(temp, 'consent') >= MAX_FAILURES_PER_FIELD) {
        await saveSession(normalized, 'AWAIT_CONSENT', temp);
        await wa.sendMessage({
          to: normalized,
          text:
            `Schreib bitte *Ja* (speichern) oder *Nein* (abbrechen).\n\n` +
            `Falls du Fragen zum Datenschutz hast: rapido-handwerk.net/datenschutz oder schreib uns auf Instagram @rapido.handwerk`,
        });
      } else {
        await saveSession(normalized, 'AWAIT_CONSENT', temp);
        await wa.sendMessage({ to: normalized, text: 'Bitte antworte mit *Ja* (speichern) oder *Nein* (abbrechen).' });
      }
      return true;
    }

    // Einwilligung erteilt → Betrieb anlegen
    await finishOnboarding(normalized, temp);
    return true;
  }

  // ── AWAIT_RANGE_CONFIRM: Spanne bestätigen ────────────────────────────────────
  if (session.step === 'AWAIT_RANGE_CONFIRM' && temp.pendingRangeField === 'employeeCount') {
    const YES = /^(ja|j|ok|okay|passt|stimmt|klar|gerne|👍|✓)/i.test(input);
    const NO  = /^(nein|n|nö|👎)/i.test(input);
    const numMatch = input.match(/^(\d+)$/);

    if (numMatch) {
      temp = resetFailure(temp, 'employeeCount');
      temp = { ...temp, employeeCount: parseInt(numMatch[1]), pendingRangeField: undefined };
    } else if (YES) {
      temp = resetFailure(temp, 'employeeCount');
      temp = { ...temp, employeeCount: temp.pendingRangeMax, pendingRangeField: undefined };
    } else if (NO) {
      temp = { ...temp, pendingRangeField: undefined };
      await saveSession(normalized, 'COLLECTING', temp);
      await wa.sendMessage({ to: normalized, text: `Kein Problem – wie viele Mitarbeiter genau?` });
      return true;
    } else {
      await saveSession(normalized, 'AWAIT_RANGE_CONFIRM', temp);
      await wa.sendMessage({
        to: normalized,
        text: `Schreib die genaue Zahl oder bestätige mit *Ja* (ich nehme dann ${temp.pendingRangeMax}).`,
      });
      return true;
    }
    // nach Bestätigung weiterfahren (unten)
  }

  // ── Resume-Erkennung: nach langer Pause kurze Zusammenfassung ─────────────────
  const timeSinceLastActivity = Date.now() - new Date(session.updatedAt).getTime();
  const isResume = timeSinceLastActivity > RESUME_THRESHOLD_MS;

  // ── LLM-Extraktion ────────────────────────────────────────────────────────────
  const currentStep = getNextMissingField(temp) ?? 'reminder';
  const extraction = await extractOnboardingData(input, {
    currentStep: session.step,
    collectedFields: getCollectedFields(temp),
    messageType,
  });

  console.info('[onboarding] intent=%s fields=%s', extraction.intent, Object.keys(extraction.fields).join(','));

  // ── Intent-Routing ────────────────────────────────────────────────────────────

  // Rückfrage beantworten, dann zurück zur aktuellen Frage
  if (extraction.intent === 'ASK_QUESTION' && extraction.question) {
    const answer = answerFAQ(extraction.question);
    if (answer) {
      const nextField = getNextMissingField(temp) as MissingField;
      await wa.sendMessage({ to: normalized, text: answer });
      await wa.sendMessage({
        to: normalized,
        text: `Zurück zu meiner Frage: ${buildQuestion(nextField, temp)}`,
      });
    } else {
      await wa.sendMessage({
        to: normalized,
        text:
          `Das kann ich leider nicht direkt beantworten. Für Fragen erreichst du uns auf ` +
          `Instagram @rapido.handwerk oder per Mail hallo@rapido-handwerk.net\n\n` +
          `Weiter geht's: ${buildQuestion(getNextMissingField(temp) as MissingField, temp)}`,
      });
    }
    await saveSession(normalized, session.step, temp);
    return true;
  }

  // Small Talk / Off-Topic
  if (extraction.intent === 'OFF_TOPIC') {
    const nextField = getNextMissingField(temp) as MissingField;
    await wa.sendMessage({
      to: normalized,
      text: `😄 Kurz weitergemacht: ${buildQuestion(nextField, temp)}`,
    });
    await saveSession(normalized, session.step, temp);
    return true;
  }

  // Korrektur: Felder überschreiben
  if (extraction.intent === 'CORRECTION') {
    const before = { ...temp };
    const { updated } = applyExtraction(temp, extraction);
    temp = updated;

    const correctedFields: string[] = [];
    if (before.ownerFirstName !== temp.ownerFirstName || before.ownerLastName !== temp.ownerLastName)
      correctedFields.push(`Name: *${temp.ownerFirstName} ${temp.ownerLastName}*`);
    if (before.companyName !== temp.companyName)
      correctedFields.push(`Betrieb: *${temp.companyName}*`);
    if (before.employeeCount !== temp.employeeCount)
      correctedFields.push(`Mitarbeiter: *${temp.employeeCount}*`);

    if (correctedFields.length > 0) {
      await wa.sendMessage({
        to: normalized,
        text: `Alles klar, ich hab das aktualisiert:\n${correctedFields.join('\n')} ✅`,
      });
    }

    const nextField = getNextMissingField(temp);
    if (!nextField) {
      await saveSession(normalized, 'AWAIT_CONSENT', temp);
      await sendDsgvoRequest(normalized, temp);
      return true;
    }
    await saveSession(normalized, session.step, temp);
    await wa.sendMessage({ to: normalized, text: buildQuestion(nextField, temp) });
    return true;
  }

  // ── PROVIDE_INFO: Felder extrahieren + vorwärtsbewegen ───────────────────────
  const beforeTemp = { ...temp };
  const { updated } = applyExtraction(temp, extraction);
  temp = updated;

  // Spanne erkannt → Bestätigung einholen
  if (temp.pendingRangeField === 'employeeCount') {
    await saveSession(normalized, 'AWAIT_RANGE_CONFIRM', temp);
    await wa.sendMessage({
      to: normalized,
      text:
        `Du hast *${temp.pendingRangeMin}–${temp.pendingRangeMax} Mitarbeiter* genannt. ` +
        `Ich nehme ${temp.pendingRangeMax} – passt das?`,
    });
    return true;
  }

  // Bestätigungen für übersprungene Felder ausgeben
  const skipConfirms = buildSkipConfirmations(beforeTemp, temp);

  // Nächstes fehlendes Feld bestimmen
  const nextMissing = getNextMissingField(temp);

  if (!nextMissing) {
    // Alle Felder gesammelt → DSGVO
    if (skipConfirms.length) await wa.sendMessage({ to: normalized, text: skipConfirms.join('\n') });
    await saveSession(normalized, 'AWAIT_CONSENT', temp);
    await sendDsgvoRequest(normalized, temp);
    return true;
  }

  // Prüfe ob sich etwas verändert hat (sonst: Failure zählen)
  const madeProgress = getCollectedFields(temp).length > getCollectedFields(beforeTemp).length;

  if (!madeProgress && !extraction.unclear) {
    temp = incrementFailure(temp, nextMissing);
    const failures = getFailureCount(temp, nextMissing);

    if (failures >= MAX_FAILURES_PER_FIELD) {
      await saveSession(normalized, session.step, temp);
      await wa.sendMessage({
        to: normalized,
        text:
          `Ich komme hier nicht weiter 😅\n\n` +
          `Für Hilfe erreichst du uns auf Instagram *@rapido.handwerk* – wir richten den Betrieb dann manuell für dich ein.`,
      });
      return true;
    }

    await saveSession(normalized, session.step, temp);
    if (isResume) {
      await wa.sendMessage({ to: normalized, text: buildRecapAndQuestion(temp, nextMissing) });
    } else {
      await wa.sendMessage({ to: normalized, text: buildQuestion(nextMissing, temp) });
    }
    return true;
  }

  // Fortschritt gemacht
  temp = resetFailure(temp, nextMissing);
  if (skipConfirms.length) await wa.sendMessage({ to: normalized, text: skipConfirms.join('\n') });

  await saveSession(normalized, 'COLLECTING', temp);

  if (isResume) {
    await wa.sendMessage({ to: normalized, text: buildRecapAndQuestion(temp, nextMissing) });
  } else {
    await wa.sendMessage({ to: normalized, text: buildQuestion(nextMissing, temp) });
  }

  return true;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeContactPhone(raw: string): string {
  // Strip whitespace, dashes, parentheses
  let p = raw.replace(/[\s\-().]/g, '');
  if (!p) return '';
  // German local numbers starting with 0 → +49
  if (p.startsWith('0')) p = '+49' + p.slice(1);
  // Ensure + prefix
  if (!p.startsWith('+')) p = '+' + p;
  // Must be at least 10 digits
  return /^\+\d{9,}$/.test(p) ? p : '';
}

// ─── DSGVO ───────────────────────────────────────────────────────────────────

async function sendDsgvoRequest(phone: string, temp: TempData): Promise<void> {
  const wa = getWhatsAppProvider();
  const ownerName = `${temp.ownerFirstName ?? ''} ${temp.ownerLastName ?? ''}`.trim();

  await wa.sendMessage({
    to: phone,
    text:
      `Fast fertig, ${ownerName}! 👍\n\n` +
      `Bevor ich alles speichere, kurz zum Datenschutz:\n\n` +
      `Rapido speichert deinen Namen, deine Mobilnummer sowie die Zeiterfassungsdaten deiner Mitarbeiter – ` +
      `ausschließlich zur Erbringung des Dienstes (DSGVO Art. 6 Abs. 1b). Du kannst deine Einwilligung jederzeit widerrufen.\n\n` +
      `📄 Datenschutz: rapido-handwerk.net/datenschutz\n` +
      `📋 Nutzungsbedingungen: rapido-handwerk.net/nutzungsbedingungen\n\n` +
      `Mit *Ja* stimmst du beiden Dokumenten zu und speicherst deinen Betrieb. *Nein* bricht ab.`,
  });
}
