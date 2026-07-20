import prisma from '../../db';
import { getWhatsAppProvider } from '../whatsapp/index';
import { IndustryType } from '@prisma/client';

// ─── Maps ─────────────────────────────────────────────────────────────────────

const INDUSTRY_MAP: Record<string, { label: string; value: IndustryType }> = {
  '1': { label: 'Handwerk', value: 'HANDWERK' },
  'handwerk': { label: 'Handwerk', value: 'HANDWERK' },
  '2': { label: 'Einzelhandel', value: 'EINZELHANDEL' },
  'einzelhandel': { label: 'Einzelhandel', value: 'EINZELHANDEL' },
  '3': { label: 'Gastronomie / Sonstiges', value: 'SONSTIGES' },
  'gastronomie': { label: 'Gastronomie / Sonstiges', value: 'SONSTIGES' },
  'sonstiges': { label: 'Gastronomie / Sonstiges', value: 'SONSTIGES' },
};

const GEWERK_MAP: Record<string, string> = {
  '1': 'Elektro', 'elektro': 'Elektro',
  '2': 'Sanitär / Heizung / Klima', 'shk': 'Sanitär / Heizung / Klima', 'sanitär': 'Sanitär / Heizung / Klima',
  '3': 'Maler / Lackierer', 'maler': 'Maler / Lackierer',
  '4': 'Maurer / Hochbau', 'maurer': 'Maurer / Hochbau',
  '5': 'Zimmerer / Holzbau', 'zimmerer': 'Zimmerer / Holzbau',
  '6': 'Dachdecker', 'dachdecker': 'Dachdecker',
  '7': 'Fliesenleger', 'fliesenleger': 'Fliesenleger',
  '8': 'Schreiner / Tischler', 'schreiner': 'Schreiner / Tischler', 'tischler': 'Schreiner / Tischler',
  '9': 'Kfz / Mechatronik', 'kfz': 'Kfz / Mechatronik',
  '10': 'Garten- und Landschaftsbau', 'garten': 'Garten- und Landschaftsbau',
  '11': 'Sonstiges Handwerk',
};

const YES = new Set(['ja', 'yes', 'j', 'ok', 'okay', '✓', 'zustimmen', 'akzeptieren', 'stimmt', 'richtig', 'korrekt']);
const NO  = new Set(['nein', 'no', 'n', 'ablehnen', 'falsch', 'korrigieren', 'ändern']);

// ─── Types ────────────────────────────────────────────────────────────────────

interface TempData {
  ownerFirstName?: string;
  ownerLastName?: string;
  companyName?: string;
  industry?: IndustryType;
  industryLabel?: string;
  gewerk?: string;
  employeeCount?: string;
  autoReminder?: boolean;
  reminderTime?: string;
  stundenzettel?: boolean;
  baustelle?: boolean;
  [key: string]: unknown;
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export async function handleCompanyOnboarding(phone: string, text: string): Promise<boolean> {
  const wa = getWhatsAppProvider();
  const normalized = phone.startsWith('+') ? phone : '+' + phone;
  const input = text.trim();
  const lower = input.toLowerCase();

  let session = await prisma.companyOnboardingSession.findUnique({ where: { phone: normalized } });

  // ── Erster Kontakt → Name fragen (DSGVO kommt am Ende) ────────────────────
  if (!session) {
    await prisma.companyOnboardingSession.create({
      data: { phone: normalized, step: 'AWAIT_OWNER_NAME' },
    });
    await wa.sendMessage({
      to: normalized,
      text:
        `👋 Hallo! Ich bin *Rapido* – deine digitale Zeiterfassung per WhatsApp.\n\n` +
        `Kein App-Download, kein Papierkram. Deine Mitarbeiter schicken einfach eine WhatsApp – das war's.\n\n` +
        `Ich richte deinen Betrieb jetzt ein. Wie heißt du? Bitte schreib Vor- und Nachname.`,
    });
    return true;
  }

  const temp = (session.tempData ?? {}) as TempData;

  // ── AWAIT_OWNER_NAME ───────────────────────────────────────────────────────
  if (session.step === 'AWAIT_OWNER_NAME') {
    const parts = input.split(/\s+/);
    if (parts.length < 2) {
      await prisma.companyOnboardingSession.update({
        where: { phone: normalized },
        data: { step: 'AWAIT_OWNER_LASTNAME', tempData: { ...temp, ownerFirstName: parts[0] } },
      });
      await wa.sendMessage({ to: normalized, text: `Und dein Nachname, ${parts[0]}?` });
      return true;
    }
    const firstName = parts[0];
    const lastName = parts.slice(1).join(' ');
    await prisma.companyOnboardingSession.update({
      where: { phone: normalized },
      data: { step: 'AWAIT_COMPANY_NAME', tempData: { ...temp, ownerFirstName: firstName, ownerLastName: lastName } },
    });
    await wa.sendMessage({
      to: normalized,
      text: `Hallo, ${firstName} ${lastName}! 👋\n\nWie heißt dein Betrieb?`,
    });
    return true;
  }

  // ── AWAIT_OWNER_LASTNAME ───────────────────────────────────────────────────
  if (session.step === 'AWAIT_OWNER_LASTNAME') {
    const lastName = input;
    const firstName = temp.ownerFirstName ?? '';
    await prisma.companyOnboardingSession.update({
      where: { phone: normalized },
      data: { step: 'AWAIT_COMPANY_NAME', tempData: { ...temp, ownerLastName: lastName } },
    });
    await wa.sendMessage({
      to: normalized,
      text: `Hallo, ${firstName} ${lastName}! 👋\n\nWie heißt dein Betrieb?`,
    });
    return true;
  }

  // ── AWAIT_COMPANY_NAME ─────────────────────────────────────────────────────
  if (session.step === 'AWAIT_COMPANY_NAME') {
    if (input.length < 2) {
      await wa.sendMessage({ to: normalized, text: 'Bitte gib einen gültigen Betriebsnamen ein.' });
      return true;
    }
    await prisma.companyOnboardingSession.update({
      where: { phone: normalized },
      data: { step: 'AWAIT_INDUSTRY', tempData: { ...temp, companyName: input } },
    });
    await wa.sendMessage({
      to: normalized,
      text:
        `In welcher Branche bist du tätig?\n\n` +
        `1️⃣ Handwerk\n2️⃣ Einzelhandel\n3️⃣ Gastronomie oder Sonstiges`,
    });
    return true;
  }

  // ── AWAIT_INDUSTRY ─────────────────────────────────────────────────────────
  if (session.step === 'AWAIT_INDUSTRY') {
    const industry = INDUSTRY_MAP[lower];
    if (!industry) {
      await wa.sendMessage({
        to: normalized,
        text: 'Bitte antworte mit *1* (Handwerk), *2* (Einzelhandel) oder *3* (Gastronomie/Sonstiges).',
      });
      return true;
    }
    const nextStep = industry.value === 'HANDWERK' ? 'AWAIT_GEWERK' : 'AWAIT_EMPLOYEES';
    await prisma.companyOnboardingSession.update({
      where: { phone: normalized },
      data: { step: nextStep, tempData: { ...temp, industry: industry.value, industryLabel: industry.label } },
    });
    if (industry.value === 'HANDWERK') {
      await wa.sendMessage({
        to: normalized,
        text:
          `Welches Gewerk?\n\n` +
          `1️⃣ Elektro\n2️⃣ Sanitär / Heizung / Klima\n3️⃣ Maler / Lackierer\n4️⃣ Maurer / Hochbau\n` +
          `5️⃣ Zimmerer / Holzbau\n6️⃣ Dachdecker\n7️⃣ Fliesenleger\n8️⃣ Schreiner / Tischler\n` +
          `9️⃣ Kfz / Mechatronik\n🔟 Garten- und Landschaftsbau\n1️⃣1️⃣ Sonstiges Handwerk`,
      });
    } else {
      await wa.sendMessage({
        to: normalized,
        text: `Wie viele Mitarbeiter hat dein Betrieb?`,
      });
    }
    return true;
  }

  // ── AWAIT_GEWERK ───────────────────────────────────────────────────────────
  if (session.step === 'AWAIT_GEWERK') {
    const gewerk = GEWERK_MAP[lower] ?? GEWERK_MAP[input.replace(/\s/g, '').toLowerCase()];
    if (!gewerk) {
      await wa.sendMessage({ to: normalized, text: 'Bitte wähle eine Zahl (1–11) oder schreib dein Gewerk.' });
      return true;
    }
    await prisma.companyOnboardingSession.update({
      where: { phone: normalized },
      data: { step: 'AWAIT_EMPLOYEES', tempData: { ...temp, gewerk } },
    });
    await wa.sendMessage({ to: normalized, text: `Wie viele Mitarbeiter hat dein Betrieb?` });
    return true;
  }

  // ── AWAIT_EMPLOYEES ────────────────────────────────────────────────────────
  if (session.step === 'AWAIT_EMPLOYEES') {
    if (!input) {
      await wa.sendMessage({ to: normalized, text: 'Bitte gib die Anzahl deiner Mitarbeiter an.' });
      return true;
    }
    await prisma.companyOnboardingSession.update({
      where: { phone: normalized },
      data: { step: 'AWAIT_REMINDER', tempData: { ...temp, employeeCount: input } },
    });
    await wa.sendMessage({
      to: normalized,
      text:
        `Wir erinnern deine Mitarbeiter täglich um 18:00 Uhr, wenn eine Zeitbuchung fehlt.\n\n` +
        `Wenn du eine andere Uhrzeit möchtest, nenn sie mir einfach. Oder schreib *Nein*, um die automatische Erinnerung zu deaktivieren.`,
    });
    return true;
  }

  // ── AWAIT_REMINDER ─────────────────────────────────────────────────────────
  if (session.step === 'AWAIT_REMINDER') {
    let autoReminder = true;
    let reminderTime: string | undefined = '18:00';

    if (NO.has(lower)) {
      autoReminder = false;
      reminderTime = undefined;
    } else {
      const timeMatch = input.match(/(\d{1,2}[:.]\d{2})/);
      if (timeMatch) reminderTime = timeMatch[0].replace('.', ':');
    }

    const info = autoReminder
      ? `Erinnerungen gehen täglich um ${reminderTime} Uhr raus.`
      : `Automatische Erinnerungen sind deaktiviert.`;

    await prisma.companyOnboardingSession.update({
      where: { phone: normalized },
      data: { step: 'AWAIT_STUNDENZETTEL', tempData: { ...temp, autoReminder, reminderTime } },
    });
    await wa.sendMessage({
      to: normalized,
      text:
        `${info}\n\n` +
        `Unterschreiben eure Kunden Stundenzettel als Nachweis? Dann kann dein Mitarbeiter das Dokument direkt per WhatsApp als Foto einschicken – Rapido speichert es automatisch und du kannst es jederzeit abrufen.\n\n` +
        `Ja oder Nein?`,
    });
    return true;
  }

  // ── AWAIT_STUNDENZETTEL ────────────────────────────────────────────────────
  if (session.step === 'AWAIT_STUNDENZETTEL') {
    if (!YES.has(lower) && !NO.has(lower)) {
      await wa.sendMessage({ to: normalized, text: 'Bitte antworte mit *Ja* oder *Nein*.' });
      return true;
    }
    await prisma.companyOnboardingSession.update({
      where: { phone: normalized },
      data: { step: 'AWAIT_BAUSTELLE', tempData: { ...temp, stundenzettel: YES.has(lower) } },
    });
    await wa.sendMessage({
      to: normalized,
      text:
        `Möchtest du auch das Baustellenmanagement aktivieren?\n\n` +
        `Deine Mitarbeiter nennen bei jeder Buchung die Baustelle – du siehst jederzeit, wer wo arbeitet. ` +
        `Das ist außerdem die Grundlage für weitere Funktionen wie Baustellenberichte und Auswertungen je Projekt.\n\n` +
        `Ja oder Nein?`,
    });
    return true;
  }

  // ── AWAIT_BAUSTELLE → DSGVO einholen ──────────────────────────────────────
  if (session.step === 'AWAIT_BAUSTELLE') {
    if (!YES.has(lower) && !NO.has(lower)) {
      await wa.sendMessage({ to: normalized, text: 'Bitte antworte mit *Ja* oder *Nein*.' });
      return true;
    }
    await prisma.companyOnboardingSession.update({
      where: { phone: normalized },
      data: { step: 'AWAIT_CONSENT', tempData: { ...temp, baustelle: YES.has(lower) } },
    });
    await wa.sendMessage({
      to: normalized,
      text:
        `Fast fertig!\n\n` +
        `Bevor ich alles speichere, kurz zum Datenschutz:\n\n` +
        `Rapido speichert deinen Namen, deine Mobilnummer sowie die Zeiterfassungsdaten deiner Mitarbeiter – ausschließlich zur Erbringung des Dienstes (DSGVO Art. 6 Abs. 1b). Du kannst deine Einwilligung jederzeit widerrufen.\n\n` +
        `📄 rapido-handwerk.net/datenschutz\n\n` +
        `Schreib *Ja* zum Speichern oder *Nein* zum Abbrechen.`,
    });
    return true;
  }

  // ── AWAIT_CONSENT → Betrieb anlegen ───────────────────────────────────────
  if (session.step === 'AWAIT_CONSENT') {
    if (NO.has(lower)) {
      await prisma.companyOnboardingSession.delete({ where: { phone: normalized } });
      await wa.sendMessage({
        to: normalized,
        text: `Kein Problem. Ohne Einwilligung werden keine Daten gespeichert. Du kannst jederzeit neu starten. 👋`,
      });
      return true;
    }
    if (!YES.has(lower)) {
      await wa.sendMessage({ to: normalized, text: 'Bitte antworte mit *Ja* (speichern) oder *Nein* (abbrechen).' });
      return true;
    }

    const finalTemp: TempData = temp;
    const ownerName = `${finalTemp.ownerFirstName ?? ''} ${finalTemp.ownerLastName ?? ''}`.trim();

    const company = await prisma.company.create({
      data: {
        name: finalTemp.companyName ?? ownerName,
        industry: finalTemp.industry ?? 'SONSTIGES',
        settings: {
          create: {
            overtimeThresholdWeek: finalTemp.industry === 'HANDWERK' ? 40 : 38,
            sundaySurchargeRate: finalTemp.industry === 'HANDWERK' ? 100 : 50,
          },
        },
        employees: {
          create: {
            name: ownerName,
            phone: normalized,
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

    await prisma.companyOnboardingSession.update({
      where: { phone: normalized },
      data: { step: 'DONE', tempData: finalTemp as unknown as import('@prisma/client').Prisma.InputJsonValue },
    });

    const extras: string[] = [];
    if (finalTemp.gewerk) extras.push(`🔧 ${finalTemp.gewerk}`);
    if (finalTemp.autoReminder) extras.push(`⏰ Erinnerung täglich um ${finalTemp.reminderTime} Uhr`);
    if (finalTemp.stundenzettel) extras.push(`📋 Stundenzettel: aktiv`);
    if (finalTemp.baustelle) extras.push(`🏗 Baustellenmanagement: aktiv`);

    await wa.sendMessage({
      to: normalized,
      text:
        `🎉 *${company.name} ist jetzt bei Rapido eingerichtet!*\n\n` +
        `👥 ${finalTemp.employeeCount} Mitarbeiter\n` +
        (extras.length ? extras.join('\n') + '\n' : '') +
        `\n*Mitarbeiter einladen:*\n` +
        `Leite diese Nachricht weiter:\n\n` +
        `——————————————\n` +
        `Dein Chef hat sich für *Rapido* entschieden. Damit können endlich die rechtlichen Vorschriften eingehalten werden und dein Chef hat weniger Arbeit mit den lästigen Stundenzetteln.\n\n` +
        `Schreib eine Nachricht an die folgende Nummer – unter der du auch in Zukunft deine Zeitbuchungen vornimmst:\n\n` +
        `📱 *+49 XXX XXXXXXX*\n\n` +
        `– ${ownerName}, ${company.name}\n` +
        `——————————————\n\n` +
        `_Einwilligung widerrufen: "Datenschutz löschen"_`,
    });
    return true;
  }

  if (session.step === 'DONE') {
    await prisma.companyOnboardingSession.delete({ where: { phone: normalized } });
  }

  return false;
}
