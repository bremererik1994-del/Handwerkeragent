import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

export type ParsedIntent =
  | 'START'
  | 'END'
  | 'DAY_ENTRY'   // single end-of-day booking: "9:00-17:30" or "8.5h"
  | 'BREAK'
  | 'KRANK'
  | 'URLAUB'
  | 'ZEITAUSGLEICH'
  | 'SONDERURLAUB'
  | 'LAGER'
  | 'UMSATZ'
  | 'KASSENABSCHLUSS'
  | 'FOTO'
  | 'ONBOARDING_OPT_IN'
  | 'ONBOARDING_OPT_OUT'
  | 'UNKNOWN';

export interface ParsedMessage {
  intent: ParsedIntent;
  // START / END
  time?: string;         // HH:MM
  locationHint?: string;
  // DAY_ENTRY: single booking
  startTime?: string;    // HH:MM
  endTime?: string;      // HH:MM
  totalHours?: number;   // alternative: "8.5h" without explicit times
  // BREAK
  breakMinutes?: number;
  // LAGER
  articleName?: string;
  stockStatus?: 'LOW' | 'OUT';
  // UMSATZ / KASSENABSCHLUSS
  amount?: number;
  currency?: string;
  // Absence fields (KRANK / URLAUB / ZEITAUSGLEICH / SONDERURLAUB)
  durationDays?: number;
  from?: string;   // "montag" | "DD.MM."
  until?: string;
  // Confidence: if low → ask clarification
  confidence: 'HIGH' | 'LOW';
  clarificationQuestion?: string;
  rawText: string;
}

const SYSTEM_PROMPT = `Du bist ein Nachrichtenparser für eine deutsche Arbeitszeiterfassungs-App.
Analysiere WhatsApp-Nachrichten von Mitarbeitern und extrahiere strukturierte Daten.

Mögliche Intents:
- START: Schichtbeginn (z.B. "Start 7:30", "Bin da", "Fange an")
- END: Schichtende (z.B. "Ende", "Fertig", "Gehe jetzt")
- DAY_ENTRY: Tagesbuchung in einer Nachricht am Abend.
    Formen: "9:00-17:30", "9-17 Pause 30", "heute 8h", "8,5 Stunden", "9:00 bis 17:30 Pause 45 Min"
    Felder: startTime (HH:MM oder null), endTime (HH:MM oder null), totalHours (Zahl oder null), breakMinutes (Zahl oder null)
- BREAK: Nur Pausen-Nachtrag (z.B. "Pause 30 Min", "30 Minuten Pause")
- LAGER: Lagerbestandsmeldung (z.B. "Artikel X fast leer")
- UMSATZ: Tagesumsatzmeldung (z.B. "Umsatz heute 1.250 €")
- KASSENABSCHLUSS: Kassenabschlussmeldung
- FOTO: Nur wenn Nachricht explizit auf gesendetes Foto verweist
- KRANK: Krankmeldung (z.B. "Ich bin krank", "Kann nicht kommen", "Arzttermin"). Felder: durationDays (Int), until (String optional)
- URLAUB: Urlaubsantrag. Felder: durationDays (Int), from (String optional "DD.MM." oder Wochentag)
- ZEITAUSGLEICH: Freizeitausgleich / Abbau von Überstunden. Felder: durationDays (Int), from (String optional)
- SONDERURLAUB: Sonderurlaub, Pflegezeit, Elternzeit, Mutterschutz. Felder: durationDays (Int optional)
- ONBOARDING_OPT_IN: Zustimmung (Ja, OK, Einverstanden)
- ONBOARDING_OPT_OUT: Ablehnung (Nein, Stop, Abmelden)
- UNKNOWN: Unklar

Antworte NUR mit einem JSON-Objekt, ohne Markdown-Codeblock.
Setze confidence auf LOW und füge clarificationQuestion hinzu, wenn die Nachricht mehrdeutig ist.
Zeitangaben im Format HH:MM (24-Stunden). Beträge als Zahl ohne Währungssymbol.`;

export async function parseWhatsAppMessage(text: string): Promise<ParsedMessage> {
  // Fast path for common patterns without LLM call
  const fastParsed = fastParse(text);
  if (fastParsed) return fastParsed;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
    });

    const raw = (response.content[0] as { text: string }).text.trim();
    const parsed = JSON.parse(raw) as ParsedMessage;
    parsed.rawText = text;
    return parsed;
  } catch (err) {
    console.error('[NLP] parse error:', err);
    return { intent: 'UNKNOWN', confidence: 'LOW', rawText: text };
  }
}

// Regex fast-path for unambiguous common messages (saves LLM calls)
function fastParse(text: string): ParsedMessage | null {
  const t = text.trim().toLowerCase();

  // "start 7:30" / "start 07:30 laden hauptstraße"
  const startMatch = t.match(/^start\s+(\d{1,2}[:.]\d{2})(.*)$/);
  if (startMatch) {
    const time = normalizeTime(startMatch[1]);
    const locationHint = startMatch[2].trim() || undefined;
    return { intent: 'START', time, locationHint, confidence: 'HIGH', rawText: text };
  }

  // "ende" / "ende, pause 30 min" / "ende 17:30" / "ende 17:30 pause 30"
  const endMatch = t.match(/^ende[,\s]*(\d{1,2}[:.]\d{2})?[,\s]*(pause\s+(\d+)\s*(min)?)?/);
  if (endMatch) {
    return {
      intent: 'END',
      time: endMatch[1] ? normalizeTime(endMatch[1]) : undefined,
      breakMinutes: endMatch[3] ? parseInt(endMatch[3]) : undefined,
      confidence: 'HIGH',
      rawText: text,
    };
  }

  // ── DAY_ENTRY patterns ──────────────────────────────────────────────────────

  // "9:00-17:30" / "9:00 - 17:30" / "9:00 bis 17:30"
  const rangeMatch = t.match(/^(\d{1,2}[:.]\d{2})\s*(?:-|bis)\s*(\d{1,2}[:.]\d{2})(.*)?$/);
  if (rangeMatch) {
    const breakMinutes = extractBreak(rangeMatch[3] ?? '');
    return {
      intent: 'DAY_ENTRY',
      startTime: normalizeTime(rangeMatch[1]),
      endTime: normalizeTime(rangeMatch[2]),
      breakMinutes,
      confidence: 'HIGH',
      rawText: text,
    };
  }

  // "9-17" / "9 - 17" (hours only, no minutes)
  const rangeShortMatch = t.match(/^(\d{1,2})\s*(?:-|bis)\s*(\d{1,2})(.*)?$/);
  if (rangeShortMatch) {
    const startHour = parseInt(rangeShortMatch[1]);
    const endHour = parseInt(rangeShortMatch[2]);
    // Sanity: both must be valid clock hours
    if (startHour >= 0 && startHour <= 23 && endHour >= 0 && endHour <= 23) {
      const breakMinutes = extractBreak(rangeShortMatch[3] ?? '');
      return {
        intent: 'DAY_ENTRY',
        startTime: `${String(startHour).padStart(2, '0')}:00`,
        endTime: `${String(endHour).padStart(2, '0')}:00`,
        breakMinutes,
        confidence: 'HIGH',
        rawText: text,
      };
    }
  }

  // "8h" / "8,5h" / "8.5 stunden" / "heute 8h" / "8 std"
  const hoursMatch = t.match(/(?:heute\s+)?(\d+(?:[.,]\d+)?)\s*(?:h|std|stunden?)\b/);
  if (hoursMatch) {
    const totalHours = parseFloat(hoursMatch[1].replace(',', '.'));
    if (totalHours > 0 && totalHours <= 24) {
      return { intent: 'DAY_ENTRY', totalHours, confidence: 'HIGH', rawText: text };
    }
  }

  // ── Other intents ──────────────────────────────────────────────────────────

  // "pause 30" / "30 min pause"
  const breakMatch = t.match(/^pause\s+(\d+)/) ?? t.match(/^(\d+)\s*min\s*pause/);
  if (breakMatch) {
    return { intent: 'BREAK', breakMinutes: parseInt(breakMatch[1]), confidence: 'HIGH', rawText: text };
  }

  // Opt-in
  if (/^(ja|ok|okay|einverstanden|stimme zu|akzeptiere)\.?$/.test(t)) {
    return { intent: 'ONBOARDING_OPT_IN', confidence: 'HIGH', rawText: text };
  }

  // Opt-out
  if (/^(nein|nö|stop|abmelden|ablehnen)\.?$/.test(t)) {
    return { intent: 'ONBOARDING_OPT_OUT', confidence: 'HIGH', rawText: text };
  }

  // ── Absence intents ────────────────────────────────────────────────────────

  if (/\bkrank\b|kann nicht kommen|nicht arbeitsfähig|arzttermin/i.test(t)) {
    const untilMatch = t.match(/bis\s+(montag|dienstag|mittwoch|donnerstag|freitag|samstag|(\d{1,2}\.\d{1,2}\.))/i);
    const dayMatch = t.match(/(\d+)\s*tag/i);
    return {
      intent: 'KRANK',
      until: untilMatch?.[1],
      durationDays: dayMatch ? parseInt(dayMatch[1]) : 1,
      confidence: 'HIGH',
      rawText: text,
    };
  }

  if (/\burlaub\b/i.test(t)) {
    const dayMatch = t.match(/(\d+)\s*tag/i);
    const fromMatch = t.match(/ab\s+(montag|dienstag|mittwoch|donnerstag|freitag|samstag|(\d{1,2}\.\d{1,2}\.))/i);
    return {
      intent: 'URLAUB',
      durationDays: dayMatch ? parseInt(dayMatch[1]) : 1,
      from: fromMatch?.[1],
      confidence: 'HIGH',
      rawText: text,
    };
  }

  if (/zeitausgleich|ausgleich\b|freizeitausgleich/i.test(t)) {
    const dayMatch = t.match(/(\d+)\s*tag/i);
    const fromMatch = t.match(/ab\s+(montag|dienstag|mittwoch|donnerstag|freitag|(\d{1,2}\.\d{1,2}\.))/i);
    return {
      intent: 'ZEITAUSGLEICH',
      durationDays: dayMatch ? parseInt(dayMatch[1]) : 1,
      from: fromMatch?.[1],
      confidence: 'HIGH',
      rawText: text,
    };
  }

  if (/sonderurlaub|pflegezeit|elternzeit|mutterschutz/i.test(t)) {
    const dayMatch = t.match(/(\d+)\s*tag/i);
    return {
      intent: 'SONDERURLAUB',
      durationDays: dayMatch ? parseInt(dayMatch[1]) : 1,
      confidence: 'HIGH',
      rawText: text,
    };
  }

  return null;
}

function normalizeTime(raw: string): string {
  return raw.replace('.', ':').padStart(5, '0');
}

function extractBreak(suffix: string): number | undefined {
  const m = suffix.match(/pause\s+(\d+)/) ?? suffix.match(/(\d+)\s*min/);
  return m ? parseInt(m[1]) : undefined;
}
