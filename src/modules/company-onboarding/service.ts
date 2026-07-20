import prisma from '../../db';
import { getWhatsAppProvider } from '../whatsapp/index';
import { IndustryType } from '@prisma/client';

const INDUSTRY_MAP: Record<string, { label: string; value: IndustryType }> = {
  '1': { label: 'Handwerk', value: 'HANDWERK' },
  'handwerk': { label: 'Handwerk', value: 'HANDWERK' },
  '2': { label: 'Einzelhandel', value: 'EINZELHANDEL' },
  'einzelhandel': { label: 'Einzelhandel', value: 'EINZELHANDEL' },
  '3': { label: 'Gastronomie / Sonstiges', value: 'SONSTIGES' },
  'gastronomie': { label: 'Gastronomie / Sonstiges', value: 'SONSTIGES' },
  'sonstiges': { label: 'Gastronomie / Sonstiges', value: 'SONSTIGES' },
};

const CONSENT_YES = new Set(['ja', 'yes', 'zustimmen', 'ok', 'akzeptieren', '✓', 'j']);
const CONSENT_NO  = new Set(['nein', 'no', 'ablehnen', 'n']);

export async function handleCompanyOnboarding(phone: string, text: string): Promise<boolean> {
  const wa = getWhatsAppProvider();
  const normalized = phone.startsWith('+') ? phone : '+' + phone;
  const input = text.trim().toLowerCase();

  let session = await prisma.companyOnboardingSession.findUnique({ where: { phone: normalized } });

  // First contact — ask for DSGVO consent before anything else
  if (!session) {
    await prisma.companyOnboardingSession.create({
      data: { phone: normalized, step: 'AWAIT_CONSENT' },
    });
    await wa.sendMessage({
      to: normalized,
      text:
        `👋 Willkommen bei *Rapido* – dein WhatsApp-Assistent für Zeiterfassung!\n\n` +
        `Bevor wir starten, benötigen wir deine Einwilligung zur Datenverarbeitung (Art. 6 Abs. 1 lit. a DSGVO):\n\n` +
        `Rapido speichert deinen Betriebsnamen, deine Mobilfunknummer und die Zeiterfassungsdaten deiner Mitarbeiter. ` +
        `Diese Daten werden ausschließlich zur Erbringung des Dienstleistung genutzt und nach Vertragsende gemäß gesetzlicher Aufbewahrungsfristen gelöscht.\n\n` +
        `📄 Datenschutzerklärung: https://rapido.app/datenschutz\n\n` +
        `Bitte antworte mit *Ja* zum Fortfahren oder *Nein* zum Abbrechen.`,
    });
    return true;
  }

  if (session.step === 'AWAIT_CONSENT') {
    if (CONSENT_NO.has(input)) {
      await prisma.companyOnboardingSession.delete({ where: { phone: normalized } });
      await wa.sendMessage({
        to: normalized,
        text: 'Verstanden. Deine Daten wurden nicht gespeichert. Falls du es dir anders überlegst, schreib uns einfach nochmal.',
      });
      return true;
    }

    if (!CONSENT_YES.has(input)) {
      await wa.sendMessage({
        to: normalized,
        text: 'Bitte antworte mit *Ja* (zustimmen) oder *Nein* (ablehnen).',
      });
      return true;
    }

    // Consent given
    await prisma.companyOnboardingSession.update({
      where: { phone: normalized },
      data: { step: 'AWAIT_NAME', tempData: { consentAt: new Date().toISOString() } },
    });
    await wa.sendMessage({
      to: normalized,
      text: `✅ Danke! Deine Einwilligung wurde gespeichert.\n\n*Wie heißt dein Betrieb?*`,
    });
    return true;
  }

  if (session.step === 'AWAIT_NAME') {
    const name = text.trim();
    if (name.length < 2) {
      await wa.sendMessage({ to: normalized, text: 'Bitte gib einen gültigen Betriebsnamen ein.' });
      return true;
    }
    const tempData = session.tempData as Record<string, string>;
    await prisma.companyOnboardingSession.update({
      where: { phone: normalized },
      data: { step: 'AWAIT_INDUSTRY', tempData: { ...tempData, companyName: name } },
    });
    await wa.sendMessage({
      to: normalized,
      text: `Super! *${name}* – gute Wahl 💪\n\nIn welcher Branche bist du tätig?\n\n1️⃣ Handwerk\n2️⃣ Einzelhandel\n3️⃣ Gastronomie / Sonstiges\n\nEinfach die Zahl antworten.`,
    });
    return true;
  }

  if (session.step === 'AWAIT_INDUSTRY') {
    const key = input;
    const industry = INDUSTRY_MAP[key];

    if (!industry) {
      await wa.sendMessage({
        to: normalized,
        text: 'Bitte antworte mit *1*, *2* oder *3*:\n\n1️⃣ Handwerk\n2️⃣ Einzelhandel\n3️⃣ Gastronomie / Sonstiges',
      });
      return true;
    }

    const tempData = session.tempData as { companyName: string; consentAt: string };

    const company = await prisma.company.create({
      data: {
        name: tempData.companyName,
        industry: industry.value,
        settings: {
          create: {
            overtimeThresholdWeek: industry.value === 'HANDWERK' ? 40 : 38,
            sundaySurchargeRate: industry.value === 'HANDWERK' ? 100 : 50,
          },
        },
        employees: {
          create: {
            name: 'Inhaber',
            phone: normalized,
            role: 'INHABER',
            employmentType: 'VOLLZEIT',
            onboardingState: 'ACTIVE',
            gdprConsent: true,
            gdprConsentAt: new Date(tempData.consentAt),
          },
        },
      },
      include: { employees: true },
    });

    await prisma.companyOnboardingSession.update({
      where: { phone: normalized },
      data: { step: 'DONE' },
    });

    await wa.sendMessage({
      to: normalized,
      text:
        `✅ *${company.name}* ist jetzt bei Rapido registriert!\n\n` +
        `*Branche:* ${industry.label}\n\n` +
        `Du kannst jetzt Mitarbeiter einladen. Schreib mir:\n` +
        `👤 *Mitarbeiter: Name, +4915...*\n\n` +
        `Oder starte deine eigene Zeiterfassung:\n` +
        `⏱ *Start 08:00*\n\n` +
        `_Du kannst deine Einwilligung jederzeit widerrufen. Schreib dazu "Datenschutz löschen"._`,
    });
    return true;
  }

  // Session DONE but employee not found — reset
  if (session.step === 'DONE') {
    await prisma.companyOnboardingSession.delete({ where: { phone: normalized } });
  }

  return false;
}
