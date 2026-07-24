import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config';
import { IndustryType } from '@prisma/client';

// ─── Public Types ─────────────────────────────────────────────────────────────

export type Intent =
  | 'PROVIDE_INFO'   // Chef gibt Informationen
  | 'CORRECTION'     // Chef korrigiert eine bereits gespeicherte Angabe
  | 'ASK_QUESTION'   // Chef stellt eine Rückfrage
  | 'OFF_TOPIC'      // Small Talk, keine relevante Info
  | 'RESTART'        // Chef will von vorne starten
  | 'STOP'           // Chef bricht den Vorgang ab
  | 'CONSENT_YES'    // Eindeutige DSGVO-Zustimmung
  | 'CONSENT_NO'     // Eindeutige DSGVO-Ablehnung
  | 'NON_TEXT';      // Bild, Sprachnachricht, Dokument

export interface FieldExtraction<T> {
  value: T;
  confidence: number; // 0.0 – 1.0
}

export interface EmployeeCountExtraction {
  value: number;
  confidence: number;
  isRange?: boolean;
  rangeMin?: number;
  rangeMax?: number;
}

export interface ExtractionResult {
  intent: Intent;
  fields: {
    ownerFirstName?: FieldExtraction<string>;
    ownerLastName?: FieldExtraction<string>;
    companyName?: FieldExtraction<string>;
    industry?: FieldExtraction<IndustryType>;
    gewerk?: FieldExtraction<string>;
    employeeCount?: EmployeeCountExtraction;
    weeklyHours?: FieldExtraction<number>;
    autoReminder?: FieldExtraction<boolean>;
    reminderTime?: FieldExtraction<string>; // "HH:MM"
    stundenzettel?: FieldExtraction<boolean>;
    baustelle?: FieldExtraction<boolean>;
  };
  question?: string;    // bei ASK_QUESTION: der Fragetext
  language?: string;    // erkannte Sprache
  unclear: boolean;
}

// ─── Extraction Prompt ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Du bist ein JSON-Extraktor für ein WhatsApp-Onboarding-System (Rapido – Zeiterfassung für Handwerksbetriebe in Deutschland). Analysiere die Nachricht eines Handwerkers und extrahiere alle erkennbaren Informationen.

## Zu extrahierende Felder
- ownerFirstName / ownerLastName: Name des Inhabers (normalisiert: Erster Buchstabe groß)
- companyName: Betriebsname (exakt wie angegeben)
- industry: "HANDWERK" | "EINZELHANDEL" | "SONSTIGES"
- gewerk: Freitext-Gewerk (z.B. "Elektro", "Sanitär/Heizung/Klima", auch Nischenberufe wie "Aufzugsbau")
- employeeCount: Anzahl der Mitarbeiter als Zahl
- weeklyHours: Wochenarbeitszeit in Stunden als Zahl (z.B. 40, 38, 35, 30); "1" → 40h, "2" → 35h, "3" → 30h (Menü-Auswahl)
- autoReminder: true = Erinnerungen aktiv, false = deaktiviert
- reminderTime: Uhrzeit als "HH:MM" (24h), z.B. "17:00"
- stundenzettel: true = Kunden unterschreiben Stundenzettel, false = nein
- baustelle: true = Baustellenmanagement gewünscht, false = nein

## Confidence-Werte (0.0 – 1.0)
- ≥ 0.85: eindeutig → kann direkt übernommen werden
- 0.70 – 0.84: wahrscheinlich → kann übernommen werden (mit niedrigerer Priorität)
- < 0.70: unsicher → NICHT extrahieren, im JSON weglassen

## Intent-Erkennung
- PROVIDE_INFO: normale Informationsgabe
- CORRECTION: Chef korrigiert eine Angabe ("achso, sind doch 8 nicht 6", "ich meinte eigentlich", "Korrektur:")
- ASK_QUESTION: Chef stellt eine Rückfrage ("wieso braucht ihr das?", "was heißt Gewerk?")
- OFF_TOPIC: reiner Small Talk ohne relevante Info ("Moin", "alles klar bei euch?")
- RESTART: Chef will neu starten ("nochmal von vorne", "neustart", "von vorne", "nochmal")
- STOP: Chef bricht ab ("stop", "abbrechen", "cancel", "nicht mehr", "vergiss es")
- CONSENT_YES: eindeutige DSGVO-Zustimmung (nur bei expliziter Ja-Antwort auf DSGVO-Frage)
- CONSENT_NO: eindeutige DSGVO-Ablehnung
- NON_TEXT: Hinweis auf nicht-textliche Nachricht (wird extern gesetzt, hier nicht nötig)

## Parsing-Regeln
- Zahlen als Wort: "zwei"=2, "drei"=3, "vier"=4, "fünf"=5, "sechs"=6, "sieben"=7, "acht"=8, "neun"=9, "zehn"=10, "zwölf"=12, "fünfzehn"=15, "zwanzig"=20
- Spannen: "ca. 6-7", "5 oder 6", "zwischen 8 und 10" → isRange=true, rangeMin, rangeMax, value=rangeMax
- Ja-Varianten: ja, j, ok, okay, passt, klar, gerne, super, genau, stimmt, richtig, prima, 👍, ✓, ✅
- Nein-Varianten: nein, n, nö, nope, nicht, ablehnen, leider nicht, 👎, ❌
- Gewerk-Mapping: "Elektriker"/"Elektro"→"Elektro", "SHK"/"Sanitär"/"Heizung"→"Sanitär/Heizung/Klima", "Maler"→"Maler/Lackierer", "Maurer"→"Maurer/Hochbau", "KFZ"/"Mechatroniker"→"Kfz/Mechatronik", "Gärtner"/"GaLaBau"→"Garten- und Landschaftsbau"
- Industrie: Gewerk-Nennung impliziert immer HANDWERK
- Mehrere Gewerke: komma-separiert extrahieren, erstes als Hauptgewerk
- Namen: "hallo ich bin Max Mustermann" → Max, Mustermann; Präfixe wie "ich bin", "heiße", "mein Name ist" ignorieren
- Firmenname-Keywords: "GmbH", "GbR", "e.K.", "OHG", "UG", "AG" deuten auf companyName hin
- Uhrzeiten: "18 Uhr", "6pm", "abends um 6", "18:30" → reminderTime als "HH:MM"
- "kein Erinnerung" / "keine Erinnerung" / "ohne" → autoReminder=false

## Antwortformat
Antworte AUSSCHLIESSLICH mit validem JSON, ohne Markdown-Codeblöcke, ohne Erklärungen:
{
  "intent": "PROVIDE_INFO",
  "fields": {
    "ownerFirstName": {"value": "Max", "confidence": 0.95},
    "employeeCount": {"value": 6, "confidence": 0.9, "isRange": false}
  },
  "question": null,
  "language": "de",
  "unclear": false
}`;

// ─── LLM Client ───────────────────────────────────────────────────────────────

const client = new Anthropic({ apiKey: config.anthropicApiKey });

// ─── Main Extraction Function ─────────────────────────────────────────────────

export async function extractOnboardingData(
  message: string,
  context: {
    currentStep: string;
    collectedFields: string[];
    isNonText?: boolean;
    messageType?: string;
  },
): Promise<ExtractionResult> {
  if (context.isNonText || (context.messageType && context.messageType !== 'text')) {
    return { intent: 'NON_TEXT', fields: {}, unclear: false };
  }

  // Quick regex pre-check for common signals (saves LLM tokens)
  const quick = quickIntentCheck(message);
  if (quick) return { intent: quick, fields: {}, unclear: false };

  const userPrompt =
    `Nachricht: "${message}"\n` +
    `Aktueller Schritt: ${context.currentStep}\n` +
    `Bereits bekannte Felder: ${context.collectedFields.join(', ') || 'keine'}`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const raw = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
    const parsed = JSON.parse(raw) as ExtractionResult;

    // Filter out low-confidence fields (< 0.70)
    const CONFIDENCE_THRESHOLD = 0.70;
    const filteredFields: ExtractionResult['fields'] = {};
    for (const [key, val] of Object.entries(parsed.fields ?? {})) {
      if (val && (val as { confidence: number }).confidence >= CONFIDENCE_THRESHOLD) {
        (filteredFields as Record<string, unknown>)[key] = val;
      }
    }
    parsed.fields = filteredFields;

    return parsed;
  } catch (err) {
    console.warn('[extraction] LLM failed, using regex fallback:', (err as Error).message);
    return regexFallback(message, context.currentStep);
  }
}

// ─── Quick Signal Detection (regex, no LLM needed) ───────────────────────────

function quickIntentCheck(text: string): Intent | null {
  const t = text.trim().toLowerCase();
  if (/^(stop|abbrechen|cancel|aufhören|abbr\.?)$/.test(t)) return 'STOP';
  if (/\b(nochmal\s+von\s+vorne|von\s+vorne\s+anfangen|neustart|neu\s+starten|nochmal\s+starten)\b/.test(t)) return 'RESTART';
  return null;
}

// ─── Regex Fallback ───────────────────────────────────────────────────────────

function regexFallback(message: string, currentStep: string): ExtractionResult {
  const t = message.trim();
  const lower = t.toLowerCase();
  const result: ExtractionResult = { intent: 'PROVIDE_INFO', fields: {}, unclear: false };

  // CONSENT step
  if (currentStep === 'AWAIT_CONSENT') {
    if (/^(ja|j|ok|okay|stimmt|einverstanden|akzeptiere)/i.test(t)) {
      result.intent = 'CONSENT_YES';
    } else if (/^(nein|n|nö|ablehnen|nicht)/i.test(t)) {
      result.intent = 'CONSENT_NO';
    } else {
      result.unclear = true;
    }
    return result;
  }

  // Name extraction
  const SKIP = new Set(['ich', 'bin', 'heiße', 'heisse', 'mein', 'name', 'ist', 'hallo', 'guten',
    'ja', 'nein', 'ok', 'okay', 'wir', 'was', 'kein', 'keine', 'der', 'die', 'das', 'und', 'mit',
    'tag', 'morgen', 'abend', 'von', 'für', 'zu', 'bei', 'an', 'auf', 'am', 'im', 'sehr',
    'mitarbeiter', 'mann', 'leute', 'personen', 'angestellte', 'betrieb', 'firma', 'handwerk']);
  const stripped = t
    .replace(/^hallo[,!\s]*/i, '')
    .replace(/^(guten\s+)?(morgen|tag|abend)[,!\s]*/i, '')
    .replace(/\b(ich\s+bin|ich\s+heiße?|mein\s+name\s+ist)\s*/gi, '')
    .trim();
  const nameWords = stripped.split(/[\s,]+/).filter(w =>
    /^[A-ZÄÖÜa-zäöüß\-]{2,}$/i.test(w) && !SKIP.has(w.toLowerCase()),
  );
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  if (nameWords.length >= 2 && currentStep === 'COLLECTING') {
    result.fields.ownerFirstName = { value: cap(nameWords[0]), confidence: 0.80 };
    result.fields.ownerLastName = { value: nameWords.slice(1).map(cap).join(' '), confidence: 0.80 };
  }

  // Gewerk keywords → implies HANDWERK
  const GEWERK_KW: Record<string, string> = {
    'elektriker': 'Elektro', 'elektro': 'Elektro', 'elektrobetrieb': 'Elektro',
    'sanitär': 'Sanitär/Heizung/Klima', 'shk': 'Sanitär/Heizung/Klima', 'heizungsbauer': 'Sanitär/Heizung/Klima', 'klempner': 'Sanitär/Heizung/Klima',
    'maler': 'Maler/Lackierer', 'lackierer': 'Maler/Lackierer',
    'maurer': 'Maurer/Hochbau', 'hochbau': 'Maurer/Hochbau',
    'zimmerer': 'Zimmerer/Holzbau', 'zimmermann': 'Zimmerer/Holzbau',
    'dachdecker': 'Dachdecker', 'fliesenleger': 'Fliesenleger',
    'schreiner': 'Schreiner/Tischler', 'tischler': 'Schreiner/Tischler',
    'kfz': 'Kfz/Mechatronik', 'mechatroniker': 'Kfz/Mechatronik',
    'gärtner': 'Garten- und Landschaftsbau', 'galabau': 'Garten- und Landschaftsbau',
  };
  for (const [kw, gewerk] of Object.entries(GEWERK_KW)) {
    if (lower.includes(kw)) {
      result.fields.gewerk = { value: gewerk, confidence: 0.85 };
      result.fields.industry = { value: 'HANDWERK', confidence: 0.90 };
      break;
    }
  }

  // Employee count
  const empKw = t.match(/(\d+)\s*(?:mitarbeiter|ma\b|mann|leute|personen?|angestellte)/i);
  if (empKw) {
    result.fields.employeeCount = { value: parseInt(empKw[1]), confidence: 0.90 };
  } else if (/^\d+$/.test(t) && currentStep === 'AWAIT_EMPLOYEES') {
    result.fields.employeeCount = { value: parseInt(t), confidence: 0.85 };
  }

  // Reminder time
  const timeMatch = t.match(/(\d{1,2})[.:](\d{2})/);
  if (timeMatch) {
    result.fields.reminderTime = {
      value: `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`,
      confidence: 0.90,
    };
    result.fields.autoReminder = { value: true, confidence: 0.85 };
  } else if (/^(nein|n)\b/i.test(t) && currentStep === 'AWAIT_REMINDER') {
    result.fields.autoReminder = { value: false, confidence: 0.90 };
  } else if (/^(ja|j\b|ok|okay|passt|klar|gerne|super)\b/i.test(t) && currentStep === 'AWAIT_REMINDER') {
    result.fields.autoReminder = { value: true, confidence: 0.85 };
    result.fields.reminderTime = { value: '18:00', confidence: 0.85 };
  }

  // Yes/No for stundenzettel and baustelle
  const isYes = /^(ja|j\b|ok|okay|passt|klar|gerne|super|stimmt|genau|jo|prima)\b/i.test(t);
  const isNo = /^(nein|n\b|nö|keine?|nicht)\b/i.test(t);
  if (currentStep === 'AWAIT_STUNDENZETTEL') {
    if (isYes) result.fields.stundenzettel = { value: true, confidence: 0.88 };
    else if (isNo) result.fields.stundenzettel = { value: false, confidence: 0.88 };
  }
  if (currentStep === 'AWAIT_BAUSTELLE') {
    if (isYes) result.fields.baustelle = { value: true, confidence: 0.88 };
    else if (isNo) result.fields.baustelle = { value: false, confidence: 0.88 };
  }

  if (Object.keys(result.fields).length === 0 && result.intent === 'PROVIDE_INFO') {
    result.unclear = true;
  }

  return result;
}
