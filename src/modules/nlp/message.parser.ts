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
  | 'RETROACTIVE'   // booking for a past day: "gestern 8-17"
  | 'CORRECTION'    // correcting an existing entry: "Korrektur: heute 9-17"
  | 'QUERY_HOURS'   // "wie viele Stunden hab ich diese Woche?"
  | 'UNKNOWN';

export interface ParsedMessage {
  intent: ParsedIntent;
  // START / END
  time?: string;         // HH:MM
  locationHint?: string;
  // DAY_ENTRY / RETROACTIVE / CORRECTION: single booking
  startTime?: string;    // HH:MM
  endTime?: string;      // HH:MM
  totalHours?: number;   // alternative: "8.5h" without explicit times
  // RETROACTIVE + CORRECTION: which date to book/correct
  retroactiveDate?: string;  // ISO "YYYY-MM-DD"
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
- DAY_ENTRY: Tagesbuchung in einer Nachricht (heutiger Tag).
    Formen: "9:00-17:30", "9-17 Pause 30", "heute 8h", "8,5 Stunden"
    Felder: startTime (HH:MM oder null), endTime (HH:MM oder null), totalHours (Zahl oder null), breakMinutes (Zahl oder null)
- RETROACTIVE: Buchung für einen VERGANGENEN Tag. Schlüsselwörter: "gestern", "vorgestern", "letzten Montag", "am Freitag", "DD.MM."
    Felder: retroactiveDate (YYYY-MM-DD, berechne aus aktuellem Datum ${new Date().toISOString().slice(0,10)}), startTime, endTime, totalHours, breakMinutes
- CORRECTION: Korrektur einer bereits gebuchten Zeit. Schlüsselwörter: "Korrektur", "Fehler", "ich meinte", "falsch", "stimmt nicht", "war nicht"
    Felder: retroactiveDate (YYYY-MM-DD, today wenn nicht angegeben), startTime, endTime, totalHours, breakMinutes
- QUERY_HOURS: Stunden-Abfrage (z.B. "Wie viele Stunden diese Woche?", "Was hab ich heute?")
- BREAK: Nur Pausen-Nachtrag (z.B. "Pause 30 Min", "30 Minuten Pause")
- LAGER: Lagerbestandsmeldung (z.B. "Artikel X fast leer")
- UMSATZ: Tagesumsatzmeldung (z.B. "Umsatz heute 1.250 €")
- KASSENABSCHLUSS: Kassenabschlussmeldung
- FOTO: Nur wenn Nachricht explizit auf gesendetes Foto verweist
- KRANK: Krankmeldung. Felder: durationDays (Int), until (String optional)
- URLAUB: Urlaubsantrag. Felder: durationDays (Int), from (String optional)
- ZEITAUSGLEICH: Freizeitausgleich. Felder: durationDays (Int), from (String optional)
- SONDERURLAUB: Sonderurlaub, Pflegezeit, Elternzeit. Felder: durationDays (Int optional)
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

  // ── QUERY_HOURS ────────────────────────────────────────────────────────────
  if (/wie\s+viele?\s+stunden|meine\s+stunden|was\s+hab\s+ich\s+(heute|diese\s+woche)|stundenstand/i.test(t)) {
    return { intent: 'QUERY_HOURS', confidence: 'HIGH', rawText: text };
  }

  // ── CORRECTION ─────────────────────────────────────────────────────────────
  const correctionTrigger = /^(korrektur|fehler[,:]|ich\s+meinte|falsch[,:]|stimmt\s+nicht|war\s+nicht|nein[,\s]+ich\s+meinte)/i.test(t);
  if (correctionTrigger) {
    const dateRef = parseDateRef(t);
    const timeRange = extractTimeRange(t);
    const hoursMatch = t.match(/(\d+(?:[.,]\d+)?)\s*(?:h|std|stunden?)\b/);
    return {
      intent: 'CORRECTION',
      retroactiveDate: dateRef ?? isoToday(),
      startTime: timeRange?.startTime,
      endTime: timeRange?.endTime,
      totalHours: hoursMatch ? parseFloat(hoursMatch[1].replace(',', '.')) : undefined,
      breakMinutes: extractBreak(t),
      confidence: 'HIGH',
      rawText: text,
    };
  }

  // ── RETROACTIVE ────────────────────────────────────────────────────────────
  const retroTrigger = /gestern|vorgestern|letzten?\s+(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)|am\s+(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)|\b\d{1,2}\.\d{1,2}\./i.test(t);
  if (retroTrigger) {
    const dateRef = parseDateRef(t);
    if (dateRef && dateRef !== isoToday()) {
      const timeRange = extractTimeRange(t);
      const hoursMatch = t.match(/(\d+(?:[.,]\d+)?)\s*(?:h|std|stunden?)\b/);
      return {
        intent: 'RETROACTIVE',
        retroactiveDate: dateRef,
        startTime: timeRange?.startTime,
        endTime: timeRange?.endTime,
        totalHours: hoursMatch ? parseFloat(hoursMatch[1].replace(',', '.')) : undefined,
        breakMinutes: extractBreak(t),
        confidence: timeRange || hoursMatch ? 'HIGH' : 'LOW',
        clarificationQuestion: !timeRange && !hoursMatch ? 'Welche Zeiten soll ich für diesen Tag nachtragen?' : undefined,
        rawText: text,
      };
    }
  }

  return null;
}

// ── Date resolution helpers ─────────────────────────────────────────────────

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseDateRef(text: string): string | null {
  const t = text.toLowerCase();
  const today = new Date();

  if (/\bgestern\b/.test(t)) return offsetDate(today, -1);
  if (/\bvorgestern\b/.test(t)) return offsetDate(today, -2);

  // "DD.MM." or "DD.MM.YYYY"
  const dmMatch = t.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})?/);
  if (dmMatch) {
    const year = dmMatch[3] ? parseInt(dmMatch[3]) : today.getFullYear();
    const d = new Date(year, parseInt(dmMatch[2]) - 1, parseInt(dmMatch[1]));
    if (!isNaN(d.getTime()) && d < today) return d.toISOString().slice(0, 10);
  }

  // Weekday references: "letzten Montag" / "am Freitag"
  const DAYS: Record<string, number> = {
    sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3,
    donnerstag: 4, freitag: 5, samstag: 6,
  };
  const dayMatch = t.match(/(?:letzten?\s+|am\s+)(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)/i);
  if (dayMatch) {
    const targetDay = DAYS[dayMatch[1].toLowerCase()];
    const current = today.getDay();
    let diff = current - targetDay;
    if (diff <= 0) diff += 7; // always go back
    return offsetDate(today, -diff);
  }

  return null;
}

function offsetDate(base: Date, days: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function extractTimeRange(text: string): { startTime: string; endTime: string } | null {
  const t = text.toLowerCase();
  // "9:00-17:30" / "9:00 bis 17:30" / "9-17"
  const full = t.match(/(\d{1,2}[:.]\d{2})\s*(?:-|bis)\s*(\d{1,2}[:.]\d{2})/);
  if (full) return { startTime: normalizeTime(full[1]), endTime: normalizeTime(full[2]) };
  const short = t.match(/(\d{1,2})\s*(?:-|bis)\s*(\d{1,2})\b/);
  if (short) {
    const s = parseInt(short[1]), e = parseInt(short[2]);
    if (s >= 4 && s <= 23 && e >= 4 && e <= 23)
      return { startTime: `${String(s).padStart(2,'0')}:00`, endTime: `${String(e).padStart(2,'0')}:00` };
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
