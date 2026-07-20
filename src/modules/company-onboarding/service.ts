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
  '1': 'Elektro',
  'elektro': 'Elektro',
  '2': 'Sanitär / Heizung / Klima (SHK)',
  'shk': 'Sanitär / Heizung / Klima (SHK)',
  'sanitär': 'Sanitär / Heizung / Klima (SHK)',
  'heizung': 'Sanitär / Heizung / Klima (SHK)',
  '3': 'Maler / Lackierer',
  'maler': 'Maler / Lackierer',
  '4': 'Maurer / Hochbau',
  'maurer': 'Maurer / Hochbau',
  'hochbau': 'Maurer / Hochbau',
  '5': 'Zimmerer / Holzbau',
  'zimmerer': 'Zimmerer / Holzbau',
  'holzbau': 'Zimmerer / Holzbau',
  '6': 'Dachdecker',
  'dachdecker': 'Dachdecker',
  '7': 'Fliesenleger',
  'fliesenleger': 'Fliesenleger',
  '8': 'Schreiner / Tischler',
  'schreiner': 'Schreiner / Tischler',
  'tischler': 'Schreiner / Tischler',
  '9': 'Kfz / Mechatronik',
  'kfz': 'Kfz / Mechatronik',
  '10': 'Garten- und Landschaftsbau',
  'garten': 'Garten- und Landschaftsbau',
  '11': 'Sonstiges Handwerk',
  'sonstiges': 'Sonstiges Handwerk',
};

const BUSINESS_FORMS: Record<string, string> = {
  'einzelunternehmen': 'Einzelunternehmen',
  'einzelunternehmer': 'Einzelunternehmen',
  'eu': 'Einzelunternehmen',
  '1': 'Einzelunternehmen',
  'gbr': 'GbR',
  '2': 'GbR',
  'gmbh': 'GmbH',
  '3': 'GmbH',
  'ug': 'UG (haftungsbeschränkt)',
  '4': 'UG (haftungsbeschränkt)',
  'kg': 'KG',
  '5': 'KG',
  'ohg': 'OHG',
  '6': 'OHG',
  'sonstiges': 'Sonstiges',
  '7': 'Sonstiges',
};

const CONSENT_YES = new Set(['ja', 'yes', 'zustimmen', 'ok', 'akzeptieren', '✓', 'j', 'okay']);
const CONSENT_NO  = new Set(['nein', 'no', 'ablehnen', 'n']);
const CONFIRM_YES = new Set(['ja', 'yes', 'j', 'ok', 'okay', 'stimmt', 'richtig', 'korrekt', '✓']);
const CONFIRM_NO  = new Set(['nein', 'no', 'n', 'falsch', 'korrigieren', 'ändern']);

// ─── Types ────────────────────────────────────────────────────────────────────

interface TempData {
  consentAt?: string;
  ownerFirstName?: string;
  ownerLastName?: string;
  companyName?: string;
  businessForm?: string;
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

  // ── Erster Kontakt: DSGVO-Einwilligung einholen ────────────────────────────
  if (!session) {
    await prisma.companyOnboardingSession.create({
      data: { phone: normalized, step: 'AWAIT_CONSENT' },
    });
    await wa.sendMessage({
      to: normalized,
      text:
        `👋 Hallo! Ich bin *Rapido* – dein digitaler Assistent für Zeiterfassung per WhatsApp.\n\n` +
        `Kein App-Download, kein Papierkram. Deine Mitarbeiter schicken einfach eine WhatsApp – fertig.\n\n` +
        `Ich richte deinen Betrieb in 2 Minuten ein. Bevor wir starten:\n\n` +
        `📋 *Datenschutz (DSGVO Art. 6):*\n` +
        `Rapido speichert deinen Namen, deine Mobilnummer und Zeiterfassungsdaten deiner Mitarbeiter – ausschließlich zur Erbringung des Dienstes.\n\n` +
        `📄 Mehr: rapido-handwerk.net/datenschutz\n\n` +
        `Antworte mit *Ja* zum Starten oder *Nein* zum Abbrechen.`,
    });
    return true;
  }

  const temp = (session.tempData ?? {}) as TempData;

  // ── AWAIT_CONSENT ──────────────────────────────────────────────────────────
  if (session.step === 'AWAIT_CONSENT') {
    if (CONSENT_NO.has(lower)) {
      await prisma.companyOnboardingSession.delete({ where: { phone: normalized } });
      await wa.sendMessage({
        to: normalized,
        text: 'Alles klar – deine Daten wurden nicht gespeichert. Melde dich jederzeit wieder, wenn du Rapido ausprobieren möchtest. 👍',
      });
      return true;
    }
    if (!CONSENT_YES.has(lower)) {
      await wa.sendMessage({ to: normalized, text: 'Bitte antworte mit *Ja* (zustimmen) oder *Nein* (ablehnen).' });
      return true;
    }
    await prisma.companyOnboardingSession.update({
      where: { phone: normalized },
      data: { step: 'AWAIT_OWNER_NAME', tempData: { consentAt: new Date().toISOString() } },
    });
    await wa.sendMessage({
      to: normalized,
      text: `✅ Super, los geht's!\n\n*Wie heißt du?*\nBitte schreib deinen Vor- und Nachnamen. (z.B. "Max Mustermann")`,
    });
    return true;
  }

  // ── AWAIT_OWNER_NAME ───────────────────────────────────────────────────────
  if (session.step === 'AWAIT_OWNER_NAME') {
    const parts = input.trim().split(/\s+/);
    if (parts.length < 2) {
      // Nur Vorname → Nachname nachfragen
      await prisma.companyOnboardingSession.update({
        where: { phone: normalized },
        data: { step: 'AWAIT_OWNER_LASTNAME', tempData: { ...temp, ownerFirstName: parts[0] } },
      });
      await wa.sendMessage({
        to: normalized,
        text: `Und dein *Nachname*, ${parts[0]}?`,
      });
      return true;
    }
    const firstName = parts[0];
    const lastName = parts.slice(1).join(' ');
    await prisma.companyOnboardingSession.update({
      where: { phone: normalized },
      data: { step: 'AWAIT_NAME_CONFIRM', tempData: { ...temp, ownerFirstName: firstName, ownerLastName: lastName } },
    });
    await wa.sendMessage({
      to: normalized,
      text: `Hallo, *${firstName} ${lastName}* 👋\n\nIst das korrekt? (Ja / Nein)`,
    });
    return true;
  }

  // ── AWAIT_OWNER_LASTNAME ───────────────────────────────────────────────────
  if (session.step === 'AWAIT_OWNER_LASTNAME') {
    const lastName = input.trim();
    const firstName = temp.ownerFirstName ?? '';
    await prisma.companyOnboardingSession.update({
      where: { phone: normalized },
      data: { step: 'AWAIT_NAME_CONFIRM', tempData: { ...temp, ownerLastName: lastName } },
    });
    await wa.sendMessage({
      to: normalized,
      text: `Hallo, *${firstName} ${lastName}* 👋\n\nIst das korrekt? (Ja / Nein)`,
    });
    return true;
  }

  // ── AWAIT_NAME_CONFIRM ─────────────────────────────────────────────────────
  if (session.step === 'AWAIT_NAME_CONFIRM') {
    if (CONFIRM_NO.has(lower)) {
      await prisma.companyOnboardingSession.update({
        where: { phone: normalized },
        data: { step: 'AWAIT_OWNER_NAME', tempData: { consentAt: temp.consentAt } },
      });
      await wa.sendMessage({
        to: normalized,
        text: `Kein Problem! Wie heißt du? (Vor- und Nachname)`,
      });
      return true;
    }
    if (!CONFIRM_YES.has(lower)) {
      await wa.sendMessage({ to: normalized, text: 'Bitte antworte mit *Ja* oder *Nein*.' });
      return true;
    }
    await prisma.companyOnboardingSession.update({
      where: { phone: normalized },
      data: { step: 'AWAIT_COMPANY_INFO' },
    });
    await wa.sendMessage({
      to: normalized,
      text:
        `Perfekt! ✅\n\n*Wie heißt dein Betrieb?*\n\n` +
        `Bitte nenn mir auch die Rechtsform:\n\n` +
        `1️⃣ Einzelunternehmen\n` +
        `2️⃣ GbR\n` +
        `3️⃣ GmbH\n` +
        `4️⃣ UG (haftungsbeschränkt)\n` +
        `5️⃣ KG\n` +
        `6️⃣ OHG\n` +
        `7️⃣ Sonstiges\n\n` +
        `_Beispiel: "Müller Bau" und dann die Zahl der Rechtsform_`,
    });
    return true;
  }

  // ── AWAIT_COMPANY_INFO (2 Nachrichten: erst Name, dann Rechtsform) ─────────
  if (session.step === 'AWAIT_COMPANY_INFO') {
    if (!temp.companyName) {
      // Erste Nachricht: Betriebsname
      const name = input.trim();
      if (name.length < 2) {
        await wa.sendMessage({ to: normalized, text: 'Bitte gib einen gültigen Betriebsnamen ein.' });
        return true;
      }
      await prisma.companyOnboardingSession.update({
        where: { phone: normalized },
        data: { tempData: { ...temp, companyName: name } },
      });
      await wa.sendMessage({
        to: normalized,
        text:
          `*${name}* – gut! 💪\n\nUnd die Rechtsform?\n\n` +
          `1️⃣ Einzelunternehmen\n2️⃣ GbR\n3️⃣ GmbH\n4️⃣ UG\n5️⃣ KG\n6️⃣ OHG\n7️⃣ Sonstiges`,
      });
      return true;
    }
    // Zweite Nachricht: Rechtsform
    const form = BUSINESS_FORMS[lower] ?? BUSINESS_FORMS[input.replace(/\s/g, '').toLowerCase()];
    if (!form) {
      await wa.sendMessage({
        to: normalized,
        text: 'Bitte wähle eine Zahl (1–7) oder schreib die Rechtsform (z.B. "GmbH").',
      });
      return true;
    }
    await prisma.companyOnboardingSession.update({
      where: { phone: normalized },
      data: { step: 'AWAIT_INDUSTRY', tempData: { ...temp, businessForm: form } },
    });
    await wa.sendMessage({
      to: normalized,
      text:
        `*${temp.companyName}* als *${form}* – notiert! ✅\n\n` +
        `*In welcher Branche bist du tätig?*\n\n` +
        `1️⃣ Handwerk\n2️⃣ Einzelhandel\n3️⃣ Gastronomie / Sonstiges`,
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
          `Handwerk – super! 🔧\n\n*Welches Gewerk?*\n\n` +
          `1️⃣ Elektro\n2️⃣ Sanitär / Heizung / Klima\n3️⃣ Maler / Lackierer\n4️⃣ Maurer / Hochbau\n` +
          `5️⃣ Zimmerer / Holzbau\n6️⃣ Dachdecker\n7️⃣ Fliesenleger\n8️⃣ Schreiner / Tischler\n` +
          `9️⃣ Kfz / Mechatronik\n🔟 Garten- und Landschaftsbau\n1️⃣1️⃣ Sonstiges Handwerk`,
      });
    } else {
      await wa.sendMessage({
        to: normalized,
        text: `*${industry.label}* – notiert! ✅\n\n*Wie viele Mitarbeiter* hat dein Betrieb ungefähr?\n_(z.B. "3", "5–10", "ca. 8")_`,
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
    await wa.sendMessage({
      to: normalized,
      text: `*${gewerk}* – perfekt! 🔧\n\n*Wie viele Mitarbeiter* hat dein Betrieb ungefähr?\n_(z.B. "3", "5–10", "ca. 8")_`,
    });
    return true;
  }

  // ── AWAIT_EMPLOYEES ────────────────────────────────────────────────────────
  if (session.step === 'AWAIT_EMPLOYEES') {
    const count = input.trim();
    if (!count) {
      await wa.sendMessage({ to: normalized, text: 'Bitte gib die Anzahl deiner Mitarbeiter an (z.B. "5").' });
      return true;
    }
    await prisma.companyOnboardingSession.update({
      where: { phone: normalized },
      data: { step: 'AWAIT_REMINDER', tempData: { ...temp, employeeCount: count } },
    });
    await wa.sendMessage({
      to: normalized,
      text:
        `*${count} Mitarbeiter* – notiert! ✅\n\n` +
        `💡 *Empfehlung:* Sollen Mitarbeiter automatisch erinnert werden, wenn eine Zeitbuchung fehlt?\n\n` +
        `Das sorgt für vollständige Aufzeichnungen ohne Nachfragen.\n\n` +
        `Antworte mit *Ja* (empfohlen) oder *Nein*.`,
    });
    return true;
  }

  // ── AWAIT_REMINDER ─────────────────────────────────────────────────────────
  if (session.step === 'AWAIT_REMINDER') {
    if (CONFIRM_YES.has(lower)) {
      await prisma.companyOnboardingSession.update({
        where: { phone: normalized },
        data: { step: 'AWAIT_REMINDER_TIME', tempData: { ...temp, autoReminder: true } },
      });
      await wa.sendMessage({
        to: normalized,
        text: `Gute Wahl! ⏰\n\n*Wann soll die Erinnerung rausgehen?*\n_(z.B. "17:00" oder "18:30")_`,
      });
    } else if (CONSENT_NO.has(lower)) {
      await prisma.companyOnboardingSession.update({
        where: { phone: normalized },
        data: { step: 'AWAIT_STUNDENZETTEL', tempData: { ...temp, autoReminder: false } },
      });
      await wa.sendMessage({
        to: normalized,
        text:
          `Alles klar.\n\n` +
          `ℹ️ Du wirst benachrichtigt, wenn Mitarbeiter das Onboarding nicht abschließen.\n\n` +
          `📋 *Stundenzettel:* Braucht ihr schriftliche Nachweise für eure Kunden?\n` +
          `Willst du Stundenzettel als Foto speichern und jederzeit abrufen können?\n\n` +
          `Antworte mit *Ja* oder *Nein*.`,
      });
    } else {
      await wa.sendMessage({ to: normalized, text: 'Bitte antworte mit *Ja* oder *Nein*.' });
    }
    return true;
  }

  // ── AWAIT_REMINDER_TIME ────────────────────────────────────────────────────
  if (session.step === 'AWAIT_REMINDER_TIME') {
    const timeMatch = input.match(/\d{1,2}[:.]\d{2}/);
    const reminderTime = timeMatch ? timeMatch[0].replace('.', ':') : input.trim();
    await prisma.companyOnboardingSession.update({
      where: { phone: normalized },
      data: { step: 'AWAIT_STUNDENZETTEL', tempData: { ...temp, reminderTime } },
    });
    await wa.sendMessage({
      to: normalized,
      text:
        `⏰ Erinnerungen um *${reminderTime} Uhr* – eingestellt!\n\n` +
        `ℹ️ Du wirst außerdem benachrichtigt, wenn Mitarbeiter das Onboarding nicht abschließen.\n\n` +
        `📋 *Stundenzettel:* Braucht ihr schriftliche Nachweise für eure Kunden?\n` +
        `Willst du Stundenzettel als Foto speichern und jederzeit abrufen können?\n\n` +
        `Antworte mit *Ja* oder *Nein*.`,
    });
    return true;
  }

  // ── AWAIT_STUNDENZETTEL ────────────────────────────────────────────────────
  if (session.step === 'AWAIT_STUNDENZETTEL') {
    if (CONFIRM_YES.has(lower)) {
      await prisma.companyOnboardingSession.update({
        where: { phone: normalized },
        data: { step: 'AWAIT_BAUSTELLE', tempData: { ...temp, stundenzettel: true } },
      });
    } else if (CONSENT_NO.has(lower)) {
      await prisma.companyOnboardingSession.update({
        where: { phone: normalized },
        data: { step: 'AWAIT_BAUSTELLE', tempData: { ...temp, stundenzettel: false } },
      });
    } else {
      await wa.sendMessage({ to: normalized, text: 'Bitte antworte mit *Ja* oder *Nein*.' });
      return true;
    }
    await wa.sendMessage({
      to: normalized,
      text:
        `🏗 *Baustellenmanagement:*\n\n` +
        `Willst du, dass deine Mitarbeiter bei jeder Buchung auch die Baustelle nennen?\n\n` +
        `Das gibt dir einen Überblick, wer wo arbeitet – und erleichtert die Abrechnung je Projekt.\n\n` +
        `Antworte mit *Ja* oder *Nein*.`,
    });
    return true;
  }

  // ── AWAIT_BAUSTELLE → Betrieb anlegen ──────────────────────────────────────
  if (session.step === 'AWAIT_BAUSTELLE') {
    let baustelle = false;
    if (CONFIRM_YES.has(lower)) {
      baustelle = true;
    } else if (!CONSENT_NO.has(lower)) {
      await wa.sendMessage({ to: normalized, text: 'Bitte antworte mit *Ja* oder *Nein*.' });
      return true;
    }

    const finalTemp: TempData = { ...temp, baustelle };
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
            gdprConsentAt: new Date(finalTemp.consentAt ?? Date.now()),
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
    if (finalTemp.gewerk) extras.push(`🔧 Gewerk: ${finalTemp.gewerk}`);
    if (finalTemp.autoReminder) extras.push(`⏰ Erinnerungen: ${finalTemp.reminderTime ?? '—'} Uhr`);
    if (finalTemp.stundenzettel) extras.push(`📋 Stundenzettel-Fotos: aktiviert`);
    if (baustelle) extras.push(`🏗 Baustellenmanagement: aktiviert`);

    await wa.sendMessage({
      to: normalized,
      text:
        `🎉 *${company.name}* ist jetzt bei Rapido registriert!\n\n` +
        `👤 Inhaber: ${ownerName}\n` +
        `🏢 Rechtsform: ${finalTemp.businessForm ?? '—'}\n` +
        `📊 Branche: ${finalTemp.industryLabel ?? '—'}\n` +
        `👥 Mitarbeiter: ca. ${finalTemp.employeeCount ?? '—'}\n` +
        (extras.length ? extras.join('\n') + '\n' : '') +
        `\n*So geht's weiter:*\n` +
        `👤 Mitarbeiter einladen: _"Mitarbeiter: Name, +4915..."_\n` +
        `⏱ Eigene Zeit buchen: _"Start 08:00"_\n\n` +
        `_Einwilligung jederzeit widerrufen: "Datenschutz löschen"_`,
    });
    return true;
  }

  // Session DONE aber kein Employee → reset
  if (session.step === 'DONE') {
    await prisma.companyOnboardingSession.delete({ where: { phone: normalized } });
  }

  return false;
}
