import prisma from '../../db';
import { getWhatsAppProvider } from '../whatsapp';
import { WA_TEMPLATES } from '../whatsapp/templates';
import type { ParsedMessage } from '../nlp/message.parser';
import type { Employee } from '@prisma/client';

// Called by webhook when opt-in/out intent detected
export async function handleOnboardingIntent(
  employee: Employee,
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
      text: 'Deine Einwilligung wurde widerrufen. Du erhältst keine weiteren Nachrichten von ZeitPilot. Du kannst jederzeit wieder mit "Ja" zustimmen.',
    });
    return;
  }

  // OPT_IN
  await prisma.employee.update({
    where: { id: employee.id },
    data: {
      gdprConsent: true,
      gdprConsentAt: new Date(),
      onboardingState: 'OPTED_IN',
    },
  });

  // Start guided onboarding dialog
  await sendOnboardingStep1(employee.phone, employee.name);
}

// Step 1: Welcome + confirm name
async function sendOnboardingStep1(phone: string, name: string) {
  const wa = getWhatsAppProvider();
  await wa.sendMessage({
    to: phone,
    text: `Super, ${name.split(' ')[0]}! 🎉 Willkommen bei ZeitPilot.\n\nSo einfach funktioniert's:\n📍 *Schichtbeginn:* Schreib "Start 8:00"\n🏁 *Schichtende:* Schreib "Ende" oder "Ende, Pause 30 Min"\n\nMöchtest du es direkt ausprobieren? Schick mir jetzt "Start" + Uhrzeit als Test!`,
  });

  // Update state to TRAINED after dialog (simplified: mark after step 1)
  // In production: track dialog state in DB
}

// Invite a new employee (called by Supervisor API)
export async function inviteEmployee(employeeId: string) {
  const employee = await prisma.employee.findUniqueOrThrow({
    where: { id: employeeId },
    include: { company: true },
  });

  const wa = getWhatsAppProvider();

  // Use approved opt-in template (Meta requires pre-approved template for first contact)
  await wa.sendMessage({
    to: employee.phone,
    template: {
      name: WA_TEMPLATES.EMPLOYEE_INVITE.name,
      language: WA_TEMPLATES.EMPLOYEE_INVITE.language,
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: employee.name },
            { type: 'text', text: employee.company.name },
          ],
        },
      ],
    },
  });

  // If template not yet approved (development), send plain text fallback
  // The MockProvider just logs it, so this works in dev without Meta approval.

  await prisma.employee.update({
    where: { id: employeeId },
    data: { onboardingState: 'INVITED' },
  });

  // Schedule reminder after 24h
  scheduleOnboardingReminder(employeeId);
}

// Simple in-process reminder scheduler (replace with a proper queue like BullMQ in production)
function scheduleOnboardingReminder(employeeId: string) {
  const reminderMs = 24 * 60 * 60 * 1000;
  setTimeout(async () => {
    const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!emp || emp.onboardingState !== 'INVITED') return;

    const wa = getWhatsAppProvider();
    await wa.sendMessage({
      to: emp.phone,
      template: {
        name: WA_TEMPLATES.ONBOARDING_REMINDER.name,
        language: WA_TEMPLATES.ONBOARDING_REMINDER.language,
        components: [{ type: 'body', parameters: [{ type: 'text', text: emp.name }] }],
      },
    });
  }, reminderMs);
}

// Mark employee as active after first real time entry
export async function markEmployeeActive(employeeId: string) {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (emp && emp.onboardingState === 'OPTED_IN') {
    await prisma.employee.update({
      where: { id: employeeId },
      data: { onboardingState: 'ACTIVE' },
    });
  }
}
