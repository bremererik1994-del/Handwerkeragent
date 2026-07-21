import type { Request, Response } from 'express';
import { config } from '../../config';
import prisma from '../../db';
import { getWhatsAppProvider } from './index';
import { parseWhatsAppMessage } from '../nlp/message.parser';
import { handleTimeTrackingIntent } from '../timetracking/service';
import { handleOnboardingIntent } from '../onboarding/service';
import { handleLocationReportIntent } from '../location/service';
import { handleKrank, handleUrlaub, handleZeitausgleich, handleSonderurlaub } from '../absence/service';
import { handleCompanyOnboarding } from '../company-onboarding/service';

// GET /webhook – Meta verification handshake
export async function verifyWebhook(req: Request, res: Response) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.whatsapp.meta.webhookVerifyToken) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
}

// POST /webhook – incoming messages from Meta
export async function handleWebhook(req: Request, res: Response) {
  // Always respond 200 quickly so Meta doesn't retry
  res.sendStatus(200);

  try {
    const body = req.body as WebhookBody;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;
        const value = change.value;

        for (const msg of value.messages ?? []) {
          await processInboundMessage(msg, value.metadata?.phone_number_id ?? '');
        }
      }
    }
  } catch (err) {
    console.error('[Webhook] processing error:', err);
  }
}

async function processInboundMessage(msg: WaMessage, phoneNumberId: string) {
  const wa = getWhatsAppProvider();
  const fromPhone = normalizePhone(msg.from);
  const text = msg.text?.body ?? msg.button?.text ?? '';
  const mediaId = msg.image?.id ?? msg.video?.id ?? msg.document?.id;
  const mediaType = msg.image ? 'image' : msg.video ? 'video' : msg.document ? 'document' : undefined;

  // Find the employee by phone
  const employee = await prisma.employee.findFirst({
    where: { phone: fromPhone, deletedAt: null },
    include: { company: { include: { settings: true } } },
  });

  if (!employee) {
    const msgType = msg.audio ? 'audio' : msg.image ? 'image' : msg.video ? 'video' : msg.document ? 'document' : 'text';
    const handled = await handleCompanyOnboarding(fromPhone, text, { messageId: msg.id, messageType: msgType });
    if (handled) return;
    console.log('[Webhook] unknown phone, no onboarding session:', maskPhone(fromPhone));
    return;
  }

  // Store inbound message
  const waMsg = await prisma.whatsAppMessage.create({
    data: {
      employeeId: employee.id,
      companyId: employee.companyId,
      waMessageId: msg.id,
      direction: 'INBOUND',
      content: text,
      mediaType,
      sentAt: new Date(parseInt(msg.timestamp) * 1000),
    },
  });

  // Mark as read
  await wa.markRead(msg.id).catch(() => {});

  // Handle media (photos)
  if (mediaId && mediaType === 'image') {
    const mediaUrl = await wa.getMediaUrl(mediaId).catch(() => '');
    await prisma.whatsAppMessage.update({
      where: { id: waMsg.id },
      data: { mediaUrl, parsedIntent: 'FOTO', processingState: 'PROCESSED' },
    });
    await handleLocationReportIntent(employee, 'FOTO', {}, mediaUrl, text);
    return;
  }

  if (!text) return;

  // Parse message intent via NLP
  const parsed = await parseWhatsAppMessage(text);

  await prisma.whatsAppMessage.update({
    where: { id: waMsg.id },
    data: {
      parsedIntent: parsed.intent,
      parsedData: parsed as unknown as any,
      processingState: parsed.confidence === 'LOW' ? 'CLARIFICATION_NEEDED' : 'PROCESSED',
    },
  });

  // DSGVO-Widerruf per WhatsApp-Kommando (Art. 7 Abs. 3)
  if (/datenschutz\s*(l[oö]schen|widerrufen|entfernen)/i.test(text)) {
    const now = new Date();
    const retainUntil = new Date(now);
    retainUntil.setFullYear(retainUntil.getFullYear() + 6);
    await prisma.employee.update({
      where: { id: employee.id },
      data: { gdprConsent: false, onboardingState: 'INVITED', deletedAt: now, retainUntil },
    });
    await wa.sendMessage({
      to: fromPhone,
      text: 'Deine Einwilligung wurde widerrufen und dein Konto zur Löschung vorgemerkt. Nach Ablauf der gesetzlichen Aufbewahrungsfrist (§147 AO) werden alle personenbezogenen Daten endgültig gelöscht.',
    });
    return;
  }

  // Route by intent
  if (parsed.intent === 'ONBOARDING_OPT_IN' || parsed.intent === 'ONBOARDING_OPT_OUT') {
    await handleOnboardingIntent(employee, parsed, waMsg.id);
    return;
  }

  // Block non-opted-in employees from time tracking (DSGVO: ohne Einwilligung keine Verarbeitung)
  if (employee.onboardingState === 'INVITED' || !employee.gdprConsent) {
    await wa.sendMessage({
      to: fromPhone,
      text: 'Bitte bestätige zuerst deine Einladung mit "Ja", um ZeitPilot zu nutzen.',
    });
    return;
  }

  if (parsed.confidence === 'LOW' && parsed.clarificationQuestion) {
    await wa.sendMessage({ to: fromPhone, text: parsed.clarificationQuestion });
    await prisma.whatsAppMessage.update({
      where: { id: waMsg.id },
      data: { clarificationSent: true },
    });
    return;
  }

  if (['START', 'END', 'BREAK', 'DAY_ENTRY'].includes(parsed.intent)) {
    await handleTimeTrackingIntent(employee, parsed, waMsg.id, fromPhone);
  } else if (['LAGER', 'UMSATZ', 'KASSENABSCHLUSS'].includes(parsed.intent)) {
    await handleLocationReportIntent(employee, parsed.intent, parsed as any, undefined, text);
  } else if (parsed.intent === 'KRANK') {
    await handleKrank(employee as any, parsed, waMsg.id, fromPhone);
  } else if (parsed.intent === 'URLAUB') {
    await handleUrlaub(employee as any, parsed, waMsg.id, fromPhone);
  } else if (parsed.intent === 'ZEITAUSGLEICH') {
    await handleZeitausgleich(employee as any, parsed, waMsg.id, fromPhone);
  } else if (parsed.intent === 'SONDERURLAUB') {
    await handleSonderurlaub(employee as any, parsed, waMsg.id, fromPhone);
  }
}

function normalizePhone(phone: string): string {
  if (phone.startsWith('+')) return phone;
  return '+' + phone;
}

function maskPhone(phone: string): string {
  // Show only country code + last 3 digits for logs: +49***531
  if (phone.length < 6) return '***';
  return phone.slice(0, 3) + '***' + phone.slice(-3);
}

// ─── Meta Webhook Payload Types ───────────────────────────────────────────────

interface WebhookBody {
  object: string;
  entry: Array<{
    changes: Array<{
      field: string;
      value: {
        metadata?: { phone_number_id: string };
        messages?: WaMessage[];
      };
    }>;
  }>;
}

interface WaMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  button?: { text: string; payload: string };
  audio?: { id: string; mime_type: string };
  image?: { id: string; mime_type: string };
  video?: { id: string; mime_type: string };
  document?: { id: string; mime_type: string };
}
