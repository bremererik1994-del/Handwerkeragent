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

export async function handleCompanyOnboarding(phone: string, text: string): Promise<boolean> {
  const wa = getWhatsAppProvider();
  const normalized = phone.startsWith('+') ? phone : '+' + phone;

  let session = await prisma.companyOnboardingSession.findUnique({ where: { phone: normalized } });

  // First contact — start onboarding
  if (!session) {
    await prisma.companyOnboardingSession.create({
      data: { phone: normalized, step: 'AWAIT_NAME' },
    });
    await wa.sendMessage({
      to: normalized,
      text: `👋 Willkommen bei *Rapido* – deinem WhatsApp-Assistenten für Zeiterfassung!\n\nIch richte deinen Betrieb in wenigen Schritten ein.\n\n*Wie heißt dein Betrieb?*`,
    });
    return true;
  }

  if (session.step === 'AWAIT_NAME') {
    const name = text.trim();
    if (name.length < 2) {
      await wa.sendMessage({ to: normalized, text: 'Bitte gib einen gültigen Betriebsnamen ein.' });
      return true;
    }
    await prisma.companyOnboardingSession.update({
      where: { phone: normalized },
      data: { step: 'AWAIT_INDUSTRY', tempData: { companyName: name } },
    });
    await wa.sendMessage({
      to: normalized,
      text: `Super! *${name}* – gute Wahl 💪\n\nIn welcher Branche bist du tätig?\n\n1️⃣ Handwerk\n2️⃣ Einzelhandel\n3️⃣ Gastronomie / Sonstiges\n\nEinfach die Zahl antworten.`,
    });
    return true;
  }

  if (session.step === 'AWAIT_INDUSTRY') {
    const key = text.trim().toLowerCase();
    const industry = INDUSTRY_MAP[key];

    if (!industry) {
      await wa.sendMessage({
        to: normalized,
        text: 'Bitte antworte mit *1*, *2* oder *3*:\n\n1️⃣ Handwerk\n2️⃣ Einzelhandel\n3️⃣ Gastronomie / Sonstiges',
      });
      return true;
    }

    const tempData = session.tempData as { companyName: string };

    // Create company + owner
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
            gdprConsentAt: new Date(),
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
      text: `✅ *${company.name}* ist jetzt bei Rapido registriert!\n\n*Branche:* ${industry.label}\n\nDu kannst jetzt Mitarbeiter einladen. Schreib mir einfach:\n👤 *Mitarbeiter: Name, +4915...* \n\nOder starte gleich mit deiner eigenen Zeiterfassung:\n⏱ *Start 08:00*`,
    });
    return true;
  }

  // Session is DONE but employee not found — shouldn't happen, reset
  if (session.step === 'DONE') {
    await prisma.companyOnboardingSession.delete({ where: { phone: normalized } });
  }

  return false;
}
