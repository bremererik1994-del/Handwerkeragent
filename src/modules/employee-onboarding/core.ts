/**
 * ============================================================
 * Rapido – Mitarbeiter-Onboarding & Zeitbuchungs-Parser
 * ============================================================
 *
 * Passt exakt zum Chef-Onboarding:
 *  - Der Chef hat konfiguriert: Wochenstunden, Erinnerungszeit (Default 17:00),
 *    Stundenzettel-Fotos (ja/nein), Baustellenmanagement (ja/nein).
 *  - Der Chef leitet die Einladung weiter ("Schreib einmal *Ja* an diese Nummer").
 *  - Der Chef schickt Kontakte -> erstelleMitarbeiterAusKontakt() legt Profile an.
 *
 * Design-Prinzipien:
 *  1. EIN Parser für Onboarding UND Alltag -> keine zwei divergierenden Logiken.
 *     Im Onboarding ist nur die Tonalität geduldiger (mehr Beispiele).
 *  2. Onboarding ist erst mit der ERSTEN erfolgreichen Buchung abgeschlossen.
 *  3. Eine Buchung VOR dem "Ja" gilt als implizite Zustimmung (kein Blockieren).
 *  4. Jede Abweichung vom Happy Path erzeugt ein ChefEvent -> landet im Dashboard
 *     unter "Braucht deinen Blick".
 *  5. Pure Functions ohne I/O -> direkt im Offline-Simulator testbar.
 *
 * Ausführen der Testfälle:  npx tsx src/modules/employee-onboarding/core.ts
 */

// ------------------------------------------------------------
// Typen
// ------------------------------------------------------------

export interface BetriebConfig {
  betriebName: string;            // "Schreiner Erik"
  chefName: string;               // "Erik Bremer"
  rapidoNummer: string;           // "+49 XXX XXXXXXX"
  wochenstunden: number;          // 40
  erinnerungUhrzeit: string | null; // "17:00" | null = deaktiviert
  stundenzettelAktiv: boolean;
  baustellenAktiv: boolean;
  baustellen: string[];           // vom Chef gepflegt, Basis fürs Fuzzy-Matching
  datenschutzUrl: string;         // "rapido-handwerk.net/datenschutz"
}

export type MitarbeiterStatus =
  | 'EINGELADEN'        // Kontakt angelegt, Einladung raus, noch keine Zustimmung
  | 'NAME_KLAEREN'      // zugestimmt, aber Name fehlt/unklar
  | 'ONBOARDING'        // zugestimmt, wartet auf erste Buchung ("Anfänger-Modus")
  | 'AKTIV'             // mind. eine erfolgreiche Buchung
  | 'ABGELEHNT'
  | 'GELOESCHT';        // DSGVO-Löschung

export interface OffeneSchicht {
  datumISO: string;               // "2026-07-24"
  start: string;                  // "07:30"
  baustelle?: string;
}

export type Pending =
  | { typ: 'BAUSTELLE'; entwurf: BuchungEntwurf }
  | { typ: 'LANGER_TAG_BESTAETIGEN'; entwurf: BuchungEntwurf; stunden: number }
  | { typ: 'START_FEHLT' }
  | { typ: 'LOESCHEN_BESTAETIGEN' }
  | { typ: 'NAME_BESTAETIGEN'; name: string };

export interface Mitarbeiter {
  telefon: string;
  name: string | null;
  status: MitarbeiterStatus;
  eingeladenAmISO: string;
  ersteBuchungAmISO: string | null;
  fehlversucheInFolge: number;
  offeneSchicht?: OffeneSchicht;
  pending?: Pending;
  verarbeiteteIds: string[];
}

export type BuchungTyp = 'ARBEIT' | 'KRANK' | 'URLAUB' | 'ZEITAUSGLEICH';

export interface BuchungEntwurf {
  typ: BuchungTyp;
  datumISO: string;
  start?: string;
  ende?: string;
  stundenDezimal?: number;
  pauseMin?: number;
  baustelle?: string;
  baustelleRoh?: string;
  korrektur?: boolean;
  notiz?: string;
  pauseAutomatischErgaenzt?: boolean;
  langerTagBestaetigt?: boolean;
}

export interface Buchung extends BuchungEntwurf {
  mitarbeiterTelefon: string;
  erfasstAmISO: string;
  ohnePauseBestaetigt?: boolean;
}

export interface StundenzettelBeleg {
  mitarbeiterTelefon: string;
  datumISO: string;
  baustelle?: string;
  kommentar?: string;
}

export type ChefEvent =
  | { typ: 'MITARBEITER_AKTIV'; telefon: string; name: string | null }
  | { typ: 'ERSTE_BUCHUNG'; telefon: string; name: string | null }
  | { typ: 'ABGELEHNT'; telefon: string; grund: string }
  | { typ: 'NAME_KORRIGIERT'; telefon: string; alt: string | null; neu: string }
  | { typ: 'ESKALATION'; telefon: string; letzteNachricht: string }
  | { typ: 'DATEN_GELOESCHT'; telefon: string }
  | { typ: 'KEINE_ANTWORT'; telefon: string; seitTagen: number }
  | { typ: 'PAUSE_NICHT_GEMACHT'; telefon: string; detail: string }
  | { typ: 'LANGER_TAG'; telefon: string; detail: string };

export interface Ergebnis {
  antworten: string[];
  mitarbeiter: Mitarbeiter;
  buchungen: Buchung[];
  belege: StundenzettelBeleg[];
  chefEvents: ChefEvent[];
}

// ------------------------------------------------------------
// Hilfsfunktionen
// ------------------------------------------------------------

function heuteISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function datumMitOffset(d: Date, tage: number): string {
  const x = new Date(d);
  x.setDate(x.getDate() - tage);
  return heuteISO(x);
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/[!,;*_~"'`´]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '');
}

function hhmm(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function zeitZuMinuten(z: string): number {
  const [h, m] = z.split(':').map(Number);
  return h * 60 + m;
}

function lev(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

export function matchBaustelle(roh: string, baustellen: string[]): string | null {
  const r = norm(roh);
  if (!r) return null;
  for (const b of baustellen) if (norm(b) === r) return b;
  for (const b of baustellen) {
    const nb = norm(b);
    if (nb.includes(r) || r.includes(nb)) return b;
  }
  const rTokens = r.split(' ').filter((x) => x.length >= 3);
  let best: { b: string; quote: number } | null = null;
  for (const b of baustellen) {
    const bTokens = norm(b).replace(/[.,]/g, '').split(' ');
    let treffer = 0;
    for (const rt of rTokens) {
      const toleranz = rt.length >= 6 ? 2 : 1;
      if (bTokens.some((bt) => bt === rt || (bt.length >= 4 && lev(bt, rt) <= toleranz))) treffer++;
    }
    const quote = rTokens.length ? treffer / rTokens.length : 0;
    if (treffer >= 1 && quote >= 0.5 && (!best || quote > best.quote)) best = { b, quote };
  }
  return best?.b ?? null;
}

// ------------------------------------------------------------
// Intent-Erkennung
// ------------------------------------------------------------

const RE_JA =
  /^(ja+|jo+|jup|jepp?|yes|ok(ay)?|klar|passt( scho+n?)?|gerne|top|läuft|si|dabei|bin dabei|mach ich|geht klar)\b/;
const RE_EMOJI_JA = /[👍✅🆗💪🙋]/u;
const RE_NEIN =
  /^(nein|ne+|nö|no)\b|kein interesse|will (das )?nicht|nicht dabei|lass mal|falsche nummer|kenn (ich|euch) nicht|hab (das|nichts) nicht angefragt/;
const RE_STOP = /\b(stopp?|abmelden|austragen)\b|datenschutz löschen|daten löschen/;
const RE_FRAGE = /\?|^ *(was|wer|wie|warum|wieso|woher|kostet|muss ich)\b/;
const RE_HILFE = /^(hilfe|befehle|commands|\?)$/;

const RE_START = /^(start|anfang|angefangen|beginn|beginne|los|bin (jetzt )?da|fang(e)? an)\b/;
const RE_ENDE = /^(ende|feierabend|fertig|schluss)\b/;
const RE_KRANK = /\bkrank\b/;
const RE_URLAUB = /\burlaub\b|\bhab(e)? frei\b|\bfrei heute\b/;
const RE_ZA = /\bza\b|zeitausgleich|überstunden ?(abbauen|abbau|abgebaut)|stunden abbauen/;

const RE_ZEIT = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(?:uhr)?\b/;
const RE_RANGE =
  /\b(\d{1,2})(?:[:.](\d{2}))?\s*(?:uhr)?\s*(?:-|–|—|bis)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(?:uhr)?\b/;
const RE_STUNDEN = /\b(\d{1,2})(?:[.,](\d))?\s*(?:h|std\.?|stunden)\b/;
const RE_PAUSE_MIN = /(\d{1,3})\s*(?:min(?:uten)?)\s*pause|pause\s*(\d{1,3})\s*min/;
const RE_PAUSE_H = /(\d)(?:[.,](\d))?\s*(?:h|std\.?|stunden?)\s*pause/;
const RE_PAUSE = /\bpause\b/;
const RE_OHNE_PAUSE =
  /\bohne pause\b|\bkeine pause\b|\bdurchgearbeitet\b|\bpause (?:vergessen|ausfallen lassen)\b/;
const RE_KORREKTUR = /\b(doch|sorry|falsch|korrektur|ändern|stimmt nicht|vergessen)\b/;
const RE_BAUSTELLE =
  /\b(?:bei|auf|an|für|baustelle|kunde|kd)\s+([a-zäöüß0-9][a-zäöüß0-9 .\-]{1,40})$/;

function extrahierePauseMin(t: string): number | undefined {
  if (RE_OHNE_PAUSE.test(t)) return 0;
  const m1 = t.match(RE_PAUSE_MIN);
  if (m1) return Number(m1[1] ?? m1[2]);
  const m2 = t.match(RE_PAUSE_H);
  if (m2) return Number(m2[1]) * 60 + (m2[2] ? Number(m2[2]) * 6 : 0);
  if (RE_PAUSE.test(t)) return -1;
  return undefined;
}

function tagOffset(t: string): number {
  if (/\bvorgestern\b/.test(t)) return 2;
  if (/\bgestern\b/.test(t)) return 1;
  return 0;
}

export function parseZeitbuchung(
  text: string,
  cfg: BetriebConfig,
  jetzt: Date,
): { entwurf?: BuchungEntwurf; typ: 'START' | 'ENDE' | 'TAG' | 'ABWESEND' | null } {
  const t = norm(text);
  const datumISO = datumMitOffset(jetzt, tagOffset(t));
  const korrektur = RE_KORREKTUR.test(t) || tagOffset(t) > 0;

  let baustelle: string | undefined;
  let baustelleRoh: string | undefined;
  const bm = t.match(RE_BAUSTELLE);
  if (bm) {
    baustelleRoh = bm[1].trim();
    baustelle = matchBaustelle(baustelleRoh, cfg.baustellen) ?? undefined;
  }
  const rest = bm ? t.replace(bm[0], '').trim() : t;

  if (RE_KRANK.test(rest)) {
    return {
      typ: 'ABWESEND',
      entwurf: {
        typ: 'KRANK', datumISO, korrektur,
        notiz: /kind/.test(rest) ? 'Kind krank' : undefined,
      },
    };
  }
  if (RE_URLAUB.test(rest)) return { typ: 'ABWESEND', entwurf: { typ: 'URLAUB', datumISO, korrektur } };
  if (RE_ZA.test(rest)) return { typ: 'ABWESEND', entwurf: { typ: 'ZEITAUSGLEICH', datumISO, korrektur } };

  const range = rest.match(RE_RANGE);
  if (range) {
    const start = hhmm(Number(range[1]), Number(range[2] ?? 0));
    const ende = hhmm(Number(range[3]), Number(range[4] ?? 0));
    return {
      typ: 'TAG',
      entwurf: {
        typ: 'ARBEIT', datumISO, start, ende, korrektur,
        pauseMin: extrahierePauseMin(rest), baustelle, baustelleRoh,
      },
    };
  }

  const stunden = rest.match(RE_STUNDEN);
  if (stunden && !RE_START.test(rest) && !RE_ENDE.test(rest)) {
    const dezimal = Number(stunden[1]) + (stunden[2] ? Number(stunden[2]) / 10 : 0);
    return {
      typ: 'TAG',
      entwurf: {
        typ: 'ARBEIT', datumISO, stundenDezimal: dezimal, korrektur,
        pauseMin: extrahierePauseMin(rest), baustelle, baustelleRoh,
      },
    };
  }

  if (RE_START.test(rest)) {
    const z = rest.replace(RE_START, '').match(RE_ZEIT);
    const start = z ? hhmm(Number(z[1]), Number(z[2] ?? 0)) : hhmm(jetzt.getHours(), jetzt.getMinutes());
    return { typ: 'START', entwurf: { typ: 'ARBEIT', datumISO, start, korrektur, baustelle, baustelleRoh } };
  }

  if (RE_ENDE.test(rest)) {
    const z = rest.replace(RE_ENDE, '').match(RE_ZEIT);
    const ende = z ? hhmm(Number(z[1]), Number(z[2] ?? 0)) : hhmm(jetzt.getHours(), jetzt.getMinutes());
    return {
      typ: 'ENDE',
      entwurf: { typ: 'ARBEIT', datumISO, ende, korrektur, pauseMin: extrahierePauseMin(rest), baustelle, baustelleRoh },
    };
  }

  return { typ: null };
}

// ------------------------------------------------------------
// Nachrichtentexte
// ------------------------------------------------------------

function befehlsUebersicht(cfg: BetriebConfig): string {
  const baustellenHinweis = cfg.baustellenAktiv
    ? '\n\n🏗 Baustelle einfach dazuschreiben: *Start 8 bei Müller*'
    : '';
  const zettelHinweis = cfg.stundenzettelAktiv
    ? '\n📸 Unterschriebenen Stundenzettel? Einfach als Foto schicken – kurzer Kommentar zur Baustelle dazu.'
    : '';
  return (
    `So einfach geht's:\n\n` +
    `⏱ *Start 8:00* – Schicht beginnen\n` +
    `🏁 *Ende* – Feierabend\n` +
    `📅 *8-17* – ganzen Tag auf einmal buchen\n` +
    `🤒 *Krank* · 🏖 *Urlaub* · ⚖️ *ZA*` +
    baustellenHinweis +
    zettelHinweis
  );
}

function datenschutzKurz(cfg: BetriebConfig): string {
  return (
    `Kurz zum Datenschutz: Rapido speichert deinen Namen, deine Nummer und deine ` +
    `Zeitbuchungen für ${cfg.betriebName} – nur zur Zeiterfassung, für nichts anderes.\n` +
    `📄 ${cfg.datenschutzUrl}\n_Abmelden jederzeit mit *Stopp*._`
  );
}

export function einladungsText(cfg: BetriebConfig): string {
  const zettel = cfg.stundenzettelAktiv
    ? `\n\nWenn ihr einen Stundenzettel vom Kunden unterschrieben bekommt, schickt das Dokument bitte als Foto per WhatsApp an diese Nummer – mit einem kurzen Kommentar zur Baustelle, damit es richtig zugeordnet wird.`
    : '';
  return (
    `——————————————\n` +
    `${cfg.betriebName} nutzt ab sofort Rapido für die digitale Zeiterfassung` +
    `${cfg.baustellenAktiv ? ' und das Baustellenmonitoring' : ''} – komplett per WhatsApp, kein App-Download, kein Papierkram.\n\n` +
    `Schreib einmal *Ja* an diese Nummer und du bist dabei:\n\n📱 ${cfg.rapidoNummer}` +
    zettel +
    `\n\n– ${cfg.chefName}\n——————————————`
  );
}

// ------------------------------------------------------------
// Buchung validieren
// ------------------------------------------------------------

interface Validierung {
  buchung?: Buchung;
  rueckfrage?: { text: string; pending: Pending };
  fehler?: string;
  chefEvents: ChefEvent[];
}

function nettoStunden(e: BuchungEntwurf): number | null {
  if (e.stundenDezimal != null) return e.stundenDezimal;
  if (e.start && e.ende) {
    const diff = zeitZuMinuten(e.ende) - zeitZuMinuten(e.start);
    return diff / 60 - (e.pauseMin && e.pauseMin > 0 ? e.pauseMin / 60 : 0);
  }
  return null;
}

function gesetzlichePauseMin(bruttoStunden: number): number {
  if (bruttoStunden > 9) return 45;
  if (bruttoStunden > 6) return 30;
  return 0;
}

function validiereBuchung(e: BuchungEntwurf, m: Mitarbeiter, cfg: BetriebConfig, jetzt: Date): Validierung {
  const events: ChefEvent[] = [];

  if (e.typ !== 'ARBEIT') {
    return {
      buchung: { ...e, mitarbeiterTelefon: m.telefon, erfasstAmISO: jetzt.toISOString() },
      chefEvents: events,
    };
  }

  if (e.pauseMin === -1) {
    const brutto = e.start && e.ende ? (zeitZuMinuten(e.ende) - zeitZuMinuten(e.start)) / 60 : 8;
    e = { ...e, pauseMin: gesetzlichePauseMin(brutto) || 30, pauseAutomatischErgaenzt: true };
  }

  if (e.start && e.ende && zeitZuMinuten(e.ende) <= zeitZuMinuten(e.start)) {
    return {
      fehler:
        `🤔 ${e.start} bis ${e.ende} – da wäre das Ende vor dem Start. ` +
        `Schreib's nochmal, z. B. *${e.start}-16:30*.`,
      chefEvents: events,
    };
  }

  const netto = nettoStunden(e);
  if (netto != null && netto > 12) {
    if (!e.langerTagBestaetigt) {
      return {
        rueckfrage: {
          text:
            `Das wären ${netto.toFixed(1).replace('.', ',')} Stunden an einem Tag – stimmt das wirklich?\n\n` +
            `*Ja* = so buchen · oder schick die richtige Zeit.`,
          pending: { typ: 'LANGER_TAG_BESTAETIGEN', entwurf: e, stunden: netto },
        },
        chefEvents: events,
      };
    }
    events.push({ typ: 'LANGER_TAG', telefon: m.telefon, detail: `${netto.toFixed(1).replace('.', ',')} h an einem Tag bestätigt` });
  }

  if (cfg.baustellenAktiv && !e.baustelle) {
    if (e.baustelleRoh) {
      const liste = cfg.baustellen.map((b, i) => `${i + 1}️⃣ ${b}`).join('\n');
      return {
        rueckfrage: {
          text:
            `„${e.baustelleRoh}" kenne ich noch nicht. Welche Baustelle meinst du?\n\n${liste}\n\n` +
            `Zahl oder Name genügt – oder *neu*, dann lege ich „${e.baustelleRoh}" an.`,
          pending: { typ: 'BAUSTELLE', entwurf: e },
        },
        chefEvents: events,
      };
    }
    const liste = cfg.baustellen.map((b, i) => `${i + 1}️⃣ ${b}`).join('\n');
    return {
      rueckfrage: {
        text: `Auf welcher Baustelle warst du?\n\n${liste}\n\nZahl oder Name genügt – oder *ohne*.`,
        pending: { typ: 'BAUSTELLE', entwurf: e },
      },
      chefEvents: events,
    };
  }

  const brutto =
    e.stundenDezimal ?? (e.start && e.ende ? (zeitZuMinuten(e.ende) - zeitZuMinuten(e.start)) / 60 : 0);
  let ohnePauseBestaetigt: boolean | undefined;
  if (e.pauseMin == null && brutto > 6) {
    e = { ...e, pauseMin: gesetzlichePauseMin(brutto), pauseAutomatischErgaenzt: true };
  } else if (e.pauseMin === 0 && brutto > 6) {
    ohnePauseBestaetigt = true;
    events.push({
      typ: 'PAUSE_NICHT_GEMACHT',
      telefon: m.telefon,
      detail: `${brutto.toFixed(1).replace('.', ',')} h ohne Pause`,
    });
  }

  return {
    buchung: { ...e, mitarbeiterTelefon: m.telefon, erfasstAmISO: jetzt.toISOString(), ohnePauseBestaetigt },
    chefEvents: events,
  };
}

function buchungsBestaetigung(b: Buchung): string {
  const datum = b.korrektur ? ` (${b.datumISO})` : '';
  if (b.typ === 'KRANK') return `🤒 Gute Besserung! Krankmeldung${datum} ist notiert.${b.notiz ? ` (${b.notiz})` : ''}`;
  if (b.typ === 'URLAUB') return `🏖 Urlaub${datum} ist eingetragen. Schöne freie Zeit!`;
  if (b.typ === 'ZEITAUSGLEICH') return `⚖️ Zeitausgleich${datum} ist eingetragen.`;
  const ort = b.baustelle ? ` · 🏗 ${b.baustelle}` : '';
  if (b.start && !b.ende && b.stundenDezimal == null) return `✅ Start ${b.start}${ort} – viel Erfolg!`;
  const pause = pauseHinweis(b);
  if (b.stundenDezimal != null)
    return `✅ ${String(b.stundenDezimal).replace('.', ',')} h${pause}${datum}${ort} gebucht.`;
  return `✅ ${b.start}–${b.ende}${pause}${ort}${datum} gebucht.`;
}

function pauseHinweis(b: Buchung): string {
  if (b.ohnePauseBestaetigt) return ' · ohne Pause';
  if (b.pauseMin) return ` · ${b.pauseMin} Min Pause${b.pauseAutomatischErgaenzt ? ' (automatisch ergänzt)' : ''}`;
  return '';
}

// ------------------------------------------------------------
// Kern: eingehende Mitarbeiter-Nachricht verarbeiten
// ------------------------------------------------------------

export function handleMitarbeiterNachricht(input: {
  cfg: BetriebConfig;
  mitarbeiter: Mitarbeiter;
  text?: string;
  medienTyp?: 'bild' | 'audio' | 'dokument' | 'video';
  messageId?: string;
  jetzt?: Date;
}): Ergebnis {
  const { cfg } = input;
  const jetzt = input.jetzt ?? new Date();
  const m: Mitarbeiter = { ...input.mitarbeiter, verarbeiteteIds: [...input.mitarbeiter.verarbeiteteIds] };
  const out: Ergebnis = { antworten: [], mitarbeiter: m, buchungen: [], belege: [], chefEvents: [] };
  const roh = input.text ?? '';
  const t = norm(roh);

  if (input.messageId) {
    if (m.verarbeiteteIds.includes(input.messageId)) return out;
    m.verarbeiteteIds.push(input.messageId);
    if (m.verarbeiteteIds.length > 20) m.verarbeiteteIds.shift();
  }

  const sagen = (s: string) => out.antworten.push(s);
  const erfolg = (b: Buchung) => {
    out.buchungen.push(b);
    m.fehlversucheInFolge = 0;
    sagen(buchungsBestaetigung(b));
    if (b.ohnePauseBestaetigt) {
      sagen(`Kurzer Hinweis: Bei über 6 Stunden ist gesetzlich eine Pause vorgesehen – denk beim nächsten Mal dran. 🙏`);
    }
    if (m.ersteBuchungAmISO == null) {
      m.ersteBuchungAmISO = heuteISO(jetzt);
      if (m.status === 'ONBOARDING' || m.status === 'EINGELADEN' || m.status === 'NAME_KLAEREN') {
        m.status = 'AKTIV';
        out.chefEvents.push({ typ: 'ERSTE_BUCHUNG', telefon: m.telefon, name: m.name });
        sagen(`🎉 Das war deine erste Buchung – ab jetzt läuft alles automatisch. Bei Fragen: *Hilfe*.`);
      }
    }
  };

  if (m.status === 'GELOESCHT') {
    sagen(`Deine Daten wurden gelöscht. Wenn du wieder mitmachen willst, sag deinem Chef Bescheid – er kann dich neu einladen.`);
    return out;
  }

  if (RE_STOP.test(t) && m.pending?.typ !== 'LOESCHEN_BESTAETIGEN') {
    m.pending = { typ: 'LOESCHEN_BESTAETIGEN' };
    sagen(
      `Verstanden. Soll ich dich abmelden und deine gespeicherten Daten löschen? ` +
        `Deine bisher gebuchten Zeiten bleiben beim Betrieb (gesetzliche Aufbewahrung), aber du bekommst keine Nachrichten mehr.\n\n*Ja* = löschen · *Nein* = doch nicht`,
    );
    return out;
  }

  if (m.pending) {
    const p = m.pending;

    if (p.typ === 'LOESCHEN_BESTAETIGEN') {
      m.pending = undefined;
      if (RE_JA.test(t) || RE_EMOJI_JA.test(roh)) {
        m.status = 'GELOESCHT';
        out.chefEvents.push({ typ: 'DATEN_GELOESCHT', telefon: m.telefon });
        sagen(`Erledigt – du bist abgemeldet. Alles Gute! 👋`);
      } else {
        sagen(`Alles klar, nichts gelöscht. Weiter geht's wie gewohnt.`);
      }
      return out;
    }

    if (p.typ === 'LANGER_TAG_BESTAETIGEN') {
      m.pending = undefined;
      if (RE_JA.test(t) || RE_EMOJI_JA.test(roh)) {
        const val = validiereBuchung({ ...p.entwurf, langerTagBestaetigt: true }, m, cfg, jetzt);
        out.chefEvents.push(...val.chefEvents);
        if (val.rueckfrage) { m.pending = val.rueckfrage.pending; sagen(val.rueckfrage.text); return out; }
        if (val.fehler) { sagen(val.fehler); return out; }
        if (val.buchung) erfolg(val.buchung);
        return out;
      }
      // Keine Bestätigung -> als neue Eingabe weiterverarbeiten
    }

    if (p.typ === 'BAUSTELLE') {
      m.pending = undefined;
      let baustelle: string | undefined;
      const zahl = t.match(/^(\d{1,2})\b/);
      if (zahl && cfg.baustellen[Number(zahl[1]) - 1]) baustelle = cfg.baustellen[Number(zahl[1]) - 1];
      else if (/^ohne\b/.test(t)) baustelle = undefined;
      else if (/^neu\b/.test(t) && p.entwurf.baustelleRoh) baustelle = p.entwurf.baustelleRoh;
      else baustelle = matchBaustelle(t, cfg.baustellen) ?? undefined;

      if (!baustelle && !/^ohne\b/.test(t) && !(/^neu\b/.test(t))) {
        m.pending = p;
        sagen(`Die kenne ich nicht. Zahl aus der Liste, Name – oder *ohne*.`);
        return out;
      }
      const val = validiereBuchung({ ...p.entwurf, baustelle, baustelleRoh: undefined }, m, cfg, jetzt);
      out.chefEvents.push(...val.chefEvents);
      if (val.rueckfrage) { m.pending = val.rueckfrage.pending; sagen(val.rueckfrage.text); return out; }
      if (val.fehler) { sagen(val.fehler); return out; }
      if (val.buchung) erfolg(val.buchung);
      return out;
    }

    if (p.typ === 'START_FEHLT') {
      m.pending = undefined;
      const z = t.match(RE_ZEIT);
      if (!z) {
        m.pending = p;
        sagen(`Sag mir kurz die Startzeit, z. B. *7:30* – dann buche ich den Tag komplett.`);
        return out;
      }
      const start = hhmm(Number(z[1]), Number(z[2] ?? 0));
      const ende = hhmm(jetzt.getHours(), jetzt.getMinutes());
      const val = validiereBuchung({ typ: 'ARBEIT', datumISO: heuteISO(jetzt), start, ende }, m, cfg, jetzt);
      out.chefEvents.push(...val.chefEvents);
      if (val.rueckfrage) { m.pending = val.rueckfrage.pending; sagen(val.rueckfrage.text); return out; }
      if (val.fehler) { sagen(val.fehler); return out; }
      if (val.buchung) erfolg(val.buchung);
      return out;
    }

    if (p.typ === 'NAME_BESTAETIGEN') {
      m.pending = undefined;
      const korrigierterName = RE_NEIN.test(t) ? parseName(roh) : null;
      if (RE_JA.test(t) || RE_EMOJI_JA.test(roh)) {
        m.name = p.name;
        m.status = 'ONBOARDING';
        out.chefEvents.push({ typ: 'MITARBEITER_AKTIV', telefon: m.telefon, name: m.name });
        sagen(`Super, ${vorname(p.name)}! 👋`);
        sagen(befehlsUebersicht(cfg));
        sagen(datenschutzKurz(cfg));
      } else if (korrigierterName) {
        out.chefEvents.push({ typ: 'NAME_KORRIGIERT', telefon: m.telefon, alt: p.name, neu: korrigierterName });
        m.name = korrigierterName;
        m.status = 'ONBOARDING';
        sagen(`Alles klar, ${vorname(korrigierterName)} – ich hab's korrigiert und deinem Chef Bescheid gegeben. 👋`);
        sagen(befehlsUebersicht(cfg));
        sagen(datenschutzKurz(cfg));
      } else if (RE_NEIN.test(t)) {
        m.status = 'NAME_KLAEREN';
        sagen(`Oh! Wie heißt du denn? Vor- und Nachname genügt.`);
      } else {
        const name = parseName(roh);
        if (name) {
          out.chefEvents.push({ typ: 'NAME_KORRIGIERT', telefon: m.telefon, alt: p.name, neu: name });
          m.name = name;
          m.status = 'ONBOARDING';
          sagen(`Alles klar, ${vorname(name)} – ich hab's korrigiert und deinem Chef Bescheid gegeben. 👋`);
          sagen(befehlsUebersicht(cfg));
          sagen(datenschutzKurz(cfg));
        } else {
          m.pending = p;
          sagen(`Kurz *Ja* oder *Nein* – bist du ${p.name}?`);
        }
      }
      return out;
    }
  }

  // Medien
  if (input.medienTyp) {
    if (input.medienTyp === 'bild' || input.medienTyp === 'dokument') {
      if (cfg.stundenzettelAktiv) {
        const rohBaustelle = roh.match(RE_BAUSTELLE)?.[1] ?? roh;
        const baustelle = matchBaustelle(rohBaustelle, cfg.baustellen) ?? undefined;
        out.belege.push({ mitarbeiterTelefon: m.telefon, datumISO: heuteISO(jetzt), baustelle, kommentar: roh || undefined });
        sagen(
          baustelle
            ? `📸 Stundenzettel gespeichert und ${baustelle} zugeordnet. Danke!`
            : `📸 Stundenzettel gespeichert. Zu welcher Baustelle gehört er? (Dein Chef kann es sonst im Dashboard zuordnen.)`,
        );
      } else {
        sagen(`Danke! Fotos kann ich aktuell nicht zuordnen – schick mir deine Zeiten bitte als Text, z. B. *8-17*.`);
      }
      return out;
    }
    if (input.medienTyp === 'audio' || input.medienTyp === 'video') {
      sagen(`Sprachnachrichten kann ich noch nicht auswerten 🙈 – schreib's mir kurz als Text, z. B. *Start 8:00*.`);
      return out;
    }
  }

  // Zeitbuchung hat immer Vorrang
  const parsed = parseZeitbuchung(roh, cfg, jetzt);
  if (parsed.typ) {
    const warNeu = m.status === 'EINGELADEN' || m.status === 'NAME_KLAEREN';

    if (parsed.typ === 'START' && parsed.entwurf) {
      if (cfg.baustellenAktiv && !parsed.entwurf.baustelle) {
        const val = validiereBuchung(parsed.entwurf, m, cfg, jetzt);
        out.chefEvents.push(...val.chefEvents);
        if (val.rueckfrage) { m.pending = val.rueckfrage.pending; sagen(val.rueckfrage.text); }
      } else {
        m.offeneSchicht = { datumISO: parsed.entwurf.datumISO, start: parsed.entwurf.start!, baustelle: parsed.entwurf.baustelle };
        m.fehlversucheInFolge = 0;
        sagen(`✅ Start ${parsed.entwurf.start}${parsed.entwurf.baustelle ? ` · 🏗 ${parsed.entwurf.baustelle}` : ''} – viel Erfolg! Zum Feierabend einfach *Ende* schreiben.`);
      }
    } else if (parsed.typ === 'ENDE' && parsed.entwurf) {
      if (!m.offeneSchicht) {
        m.pending = { typ: 'START_FEHLT' };
        sagen(`Ich habe keinen Start von dir. Wann hast du heute angefangen? (z. B. *7:30*)`);
      } else {
        const entwurf: BuchungEntwurf = {
          typ: 'ARBEIT',
          datumISO: m.offeneSchicht.datumISO,
          start: m.offeneSchicht.start,
          ende: parsed.entwurf.ende,
          pauseMin: parsed.entwurf.pauseMin,
          baustelle: parsed.entwurf.baustelle ?? m.offeneSchicht.baustelle,
        };
        m.offeneSchicht = undefined;
        const val = validiereBuchung(entwurf, m, cfg, jetzt);
        out.chefEvents.push(...val.chefEvents);
        if (val.rueckfrage) { m.pending = val.rueckfrage.pending; sagen(val.rueckfrage.text); }
        else if (val.fehler) sagen(val.fehler);
        else if (val.buchung) erfolg(val.buchung);
      }
    } else if (parsed.entwurf) {
      const val = validiereBuchung(parsed.entwurf, m, cfg, jetzt);
      out.chefEvents.push(...val.chefEvents);
      if (val.rueckfrage) { m.pending = val.rueckfrage.pending; sagen(val.rueckfrage.text); }
      else if (val.fehler) sagen(val.fehler);
      else if (val.buchung) erfolg(val.buchung);
    }

    if (warNeu && m.status !== 'AKTIV') m.status = 'ONBOARDING';
    if (warNeu) {
      out.chefEvents.push({ typ: 'MITARBEITER_AKTIV', telefon: m.telefon, name: m.name });
      sagen(datenschutzKurz(cfg));
    }
    return out;
  }

  // Statusabhängige Konversation
  switch (m.status) {
    case 'EINGELADEN': {
      if (RE_JA.test(t) || RE_EMOJI_JA.test(roh)) {
        if (m.name) {
          m.pending = { typ: 'NAME_BESTAETIGEN', name: m.name };
          sagen(`Willkommen bei ${cfg.betriebName}! 👋 Kurz zur Sicherheit: Bist du *${m.name}*? (Ja/Nein)`);
        } else {
          m.status = 'NAME_KLAEREN';
          sagen(`Willkommen bei ${cfg.betriebName}! 👋 Wie heißt du? Vor- und Nachname genügt.`);
        }
        return out;
      }
      if (RE_NEIN.test(t)) {
        m.status = 'ABGELEHNT';
        out.chefEvents.push({ typ: 'ABGELEHNT', telefon: m.telefon, grund: roh });
        sagen(
          `Alles klar, ich schreibe dir nicht weiter. ${cfg.chefName} (${cfg.betriebName}) hatte dich für die ` +
            `Zeiterfassung eingeladen – sprich ihn einfach an, falls das ein Missverständnis war. 👋`,
        );
        return out;
      }
      if (RE_FRAGE.test(t)) {
        sagen(faqAntwort(t, cfg));
        sagen(`Wenn du dabei bist, schreib einfach *Ja*.`);
        return out;
      }
      sagen(
        `Hi! 👋 ${cfg.chefName} von ${cfg.betriebName} hat dich zur Zeiterfassung per WhatsApp eingeladen – ` +
          `kein App-Download nötig. Mit *Ja* bist du dabei.`,
      );
      return out;
    }

    case 'NAME_KLAEREN': {
      const name = parseName(roh);
      if (name) {
        m.name = name;
        m.status = 'ONBOARDING';
        out.chefEvents.push({ typ: 'MITARBEITER_AKTIV', telefon: m.telefon, name });
        sagen(`Super, ${vorname(name)}! 👋`);
        sagen(befehlsUebersicht(cfg));
        sagen(datenschutzKurz(cfg));
      } else {
        sagen(`Das habe ich nicht als Namen erkannt 🙈 – schreib bitte einfach Vor- und Nachname, z. B. *Max Mustermann*.`);
      }
      return out;
    }

    case 'ABGELEHNT': {
      if (RE_JA.test(t) || RE_EMOJI_JA.test(roh)) {
        m.status = m.name ? 'ONBOARDING' : 'NAME_KLAEREN';
        sagen(`Schön, dass du doch dabei bist! 🎉`);
        if (m.name) { sagen(befehlsUebersicht(cfg)); sagen(datenschutzKurz(cfg)); }
        else sagen(`Wie heißt du? Vor- und Nachname genügt.`);
      } else {
        sagen(`Du bist aktuell abgemeldet. Mit *Ja* kannst du jederzeit wieder einsteigen.`);
      }
      return out;
    }

    case 'ONBOARDING':
    case 'AKTIV': {
      if (RE_HILFE.test(t)) { sagen(befehlsUebersicht(cfg)); m.fehlversucheInFolge = 0; return out; }
      if (RE_FRAGE.test(t)) { sagen(faqAntwort(t, cfg)); return out; }

      m.fehlversucheInFolge += 1;
      if (m.fehlversucheInFolge >= 3) {
        out.chefEvents.push({ typ: 'ESKALATION', telefon: m.telefon, letzteNachricht: roh });
        m.fehlversucheInFolge = 0;
        sagen(
          `Ich komme hier nicht weiter, sorry! Ich habe ${cfg.chefName} Bescheid gegeben – er meldet sich bei dir. ` +
            `Deine Nachricht ist gespeichert, es geht nichts verloren. 🙏`,
        );
      } else if (m.status === 'ONBOARDING') {
        sagen(
          `🤔 Das habe ich nicht ganz verstanden.\n\nVersuch's mal so:\n` +
            `• *Start 8:00* – Schicht starten\n• *Ende* – Feierabend\n• *8-17* – ganzer Tag\n• *Krank* – Krankmeldung\n\n` +
            `Oder schreib *Hilfe* für alle Befehle.`,
        );
      } else {
        sagen(`🤔 Das habe ich nicht verstanden. *Hilfe* zeigt dir alle Befehle.`);
      }
      return out;
    }
  }

  return out;
}

function vorname(name: string): string {
  return name.split(' ')[0];
}

export function parseName(roh: string): string | null {
  let t = roh
    .replace(/^(hi|hallo|hey|moin|servus)[,!.\s]*/i, '')
    .replace(/^(nee+|ne|nein|nö)[,!.\s]*/i, '')
    .replace(/\b(ich )?(bin|heiße|heisse|heiß)\b/gi, ' ')
    .replace(/\b(der|die|das|übrigens|hier|neu(e)?( hier)?)\b/gi, ' ')
    .replace(/[^a-zA-ZäöüÄÖÜß\- ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  const teile = t.split(' ').filter((w) => w.length >= 2);
  if (teile.length === 0 || teile.length > 3) return null;
  if (/^(ja|nein|ok|start|ende|krank|urlaub|hilfe)$/i.test(teile[0])) return null;
  return teile.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function faqAntwort(t: string, cfg: BetriebConfig): string {
  if (/kostet|geld|bezahlen|preis/.test(t))
    return `Für dich ist Rapido komplett kostenlos – ${cfg.betriebName} übernimmt das. 👍`;
  if (/wer (bist|seid|ist)|was ist (das|rapido)/.test(t))
    return (
      `Ich bin der Rapido-Bot – ${cfg.chefName} (${cfg.betriebName}) nutzt mich für die Zeiterfassung. ` +
      `Du schreibst nur kurz, wann du anfängst und aufhörst. Kein Papierkram, keine App.`
    );
  if (/datenschutz|daten|dsgvo|gespeichert/.test(t))
    return datenschutzKurz(cfg);
  if (/muss ich|pflicht/.test(t))
    return `Dein Betrieb muss Arbeitszeiten dokumentieren – mit Rapido dauert das für dich nur ein paar Sekunden am Tag. Fragen dazu beantwortet dir ${cfg.chefName}.`;
  return `Gute Frage! Am besten fragst du ${cfg.chefName} direkt – ich kümmere mich hier nur um deine Zeiten. Mit *Hilfe* siehst du alle Befehle.`;
}

// ------------------------------------------------------------
// Kontaktimport
// ------------------------------------------------------------

export function erstelleMitarbeiterAusKontakt(
  kontakt: { name?: string; telefon: string },
  jetzt: Date = new Date(),
): { mitarbeiter: Mitarbeiter; einladung: string } {
  return {
    mitarbeiter: {
      telefon: kontakt.telefon,
      name: kontakt.name?.trim() || null,
      status: 'EINGELADEN',
      eingeladenAmISO: heuteISO(jetzt),
      ersteBuchungAmISO: null,
      fehlversucheInFolge: 0,
      verarbeiteteIds: [],
    },
    einladung: `Einladung an ${kontakt.name ?? kontakt.telefon} verschickt ✅`,
  };
}

// ------------------------------------------------------------
// Erinnerungen & Timeouts
// ------------------------------------------------------------

export interface FaelligeAktion {
  telefon: string;
  nachricht?: string;
  chefEvent?: ChefEvent;
}

export function faelligeAktionen(input: {
  cfg: BetriebConfig;
  mitarbeiterListe: Mitarbeiter[];
  hatBuchungHeute: (telefon: string) => boolean;
  jetzt: Date;
}): FaelligeAktion[] {
  const { cfg, mitarbeiterListe, hatBuchungHeute, jetzt } = input;
  const aktionen: FaelligeAktion[] = [];
  const wochentag = jetzt.getDay();
  const istWerktag = wochentag >= 1 && wochentag <= 5;

  for (const m of mitarbeiterListe) {
    if (m.status === 'EINGELADEN') {
      const tage = Math.floor((jetzt.getTime() - new Date(m.eingeladenAmISO).getTime()) / 86400000);
      if (tage === 1)
        aktionen.push({
          telefon: m.telefon,
          nachricht: `Kurze Erinnerung: ${cfg.betriebName} wartet auf dich bei der Zeiterfassung. Mit *Ja* bist du in 10 Sekunden dabei. 👍`,
        });
      if (tage >= 3)
        aktionen.push({ telefon: m.telefon, chefEvent: { typ: 'KEINE_ANTWORT', telefon: m.telefon, seitTagen: tage } });
      continue;
    }

    if ((m.status === 'AKTIV' || m.status === 'ONBOARDING') && cfg.erinnerungUhrzeit && istWerktag) {
      const [eh, em] = cfg.erinnerungUhrzeit.split(':').map(Number);
      const faellig = jetzt.getHours() > eh || (jetzt.getHours() === eh && jetzt.getMinutes() >= em);
      if (faellig && !hatBuchungHeute(m.telefon) && !m.offeneSchicht) {
        aktionen.push({
          telefon: m.telefon,
          nachricht: `⏰ Für heute fehlt noch deine Zeit. Einfach kurz antworten, z. B. *8-17* – oder *Krank* / *Urlaub*.`,
        });
      }
      if (faellig && m.offeneSchicht?.datumISO === heuteISO(jetzt)) {
        aktionen.push({
          telefon: m.telefon,
          nachricht: `Du bist seit ${m.offeneSchicht.start} eingebucht${m.offeneSchicht.baustelle ? ` (🏗 ${m.offeneSchicht.baustelle})` : ''}. Feierabend? Dann schreib *Ende*.`,
        });
      }
    }
  }
  return aktionen;
}

// ------------------------------------------------------------
// Testfälle (npx tsx src/modules/employee-onboarding/core.ts)
// ------------------------------------------------------------

const TEST_CFG: BetriebConfig = {
  betriebName: 'Schreiner Erik',
  chefName: 'Erik Bremer',
  rapidoNummer: '+49 XXX XXXXXXX',
  wochenstunden: 40,
  erinnerungUhrzeit: '17:00',
  stundenzettelAktiv: true,
  baustellenAktiv: true,
  baustellen: ['Müller, Dachstuhl', 'Kita Sonnenschein', 'Praxis Dr. Weber'],
  datenschutzUrl: 'rapido-handwerk.net/datenschutz',
};

function frisch(status: MitarbeiterStatus, name: string | null = 'Micha Krause'): Mitarbeiter {
  return {
    telefon: '+4915780000002', name, status,
    eingeladenAmISO: '2026-07-20', ersteBuchungAmISO: status === 'AKTIV' ? '2026-07-21' : null,
    fehlversucheInFolge: 0, verarbeiteteIds: [],
  };
}

const JETZT = new Date('2026-07-24T16:10:00');

interface Testfall {
  name: string;
  status: MitarbeiterStatus;
  eingabe: string;
  medienTyp?: 'bild' | 'audio';
  vorher?: (m: Mitarbeiter) => void;
  pruefe: (r: Ergebnis) => boolean;
}

const TESTFAELLE: Testfall[] = [
  { name: 'Ja klassisch', status: 'EINGELADEN', eingabe: 'Ja', pruefe: (r) => r.mitarbeiter.pending?.typ === 'NAME_BESTAETIGEN' },
  { name: 'Ja umgangssprachlich', status: 'EINGELADEN', eingabe: 'jo bin dabei', pruefe: (r) => r.mitarbeiter.pending?.typ === 'NAME_BESTAETIGEN' },
  { name: 'Ja per Emoji', status: 'EINGELADEN', eingabe: '👍', pruefe: (r) => r.mitarbeiter.pending?.typ === 'NAME_BESTAETIGEN' },
  { name: 'Ablehnung', status: 'EINGELADEN', eingabe: 'nein kein interesse', pruefe: (r) => r.mitarbeiter.status === 'ABGELEHNT' && r.chefEvents.some((e) => e.typ === 'ABGELEHNT') },
  { name: 'Falsche Nummer', status: 'EINGELADEN', eingabe: 'falsche nummer, kenn euch nicht', pruefe: (r) => r.mitarbeiter.status === 'ABGELEHNT' },
  { name: 'Frage: Kosten', status: 'EINGELADEN', eingabe: 'kostet das was?', pruefe: (r) => r.antworten[0].includes('kostenlos') && r.mitarbeiter.status === 'EINGELADEN' },
  { name: 'Frage: Wer seid ihr', status: 'EINGELADEN', eingabe: 'wer seid ihr überhaupt', pruefe: (r) => r.antworten[0].includes('Schreiner Erik') },
  { name: 'Small Talk', status: 'EINGELADEN', eingabe: 'Moin', pruefe: (r) => r.antworten[0].includes('*Ja*') },
  { name: 'Direkt-Buchung = implizite Zustimmung', status: 'EINGELADEN', eingabe: 'start 8 bei müller', pruefe: (r) => r.mitarbeiter.status !== 'EINGELADEN' && r.mitarbeiter.offeneSchicht?.baustelle === 'Müller, Dachstuhl' },
  { name: 'Name bestätigen', status: 'EINGELADEN', eingabe: 'ja', vorher: (m) => (m.pending = { typ: 'NAME_BESTAETIGEN', name: 'Micha Krause' }), pruefe: (r) => r.mitarbeiter.status === 'ONBOARDING' },
  { name: 'Name korrigieren', status: 'EINGELADEN', eingabe: 'nee ich bin Sven Krause', vorher: (m) => (m.pending = { typ: 'NAME_BESTAETIGEN', name: 'Micha Krause' }), pruefe: (r) => r.mitarbeiter.name === 'Sven Krause' && r.chefEvents.some((e) => e.typ === 'NAME_KORRIGIERT') },
  { name: 'Name aus Freitext', status: 'NAME_KLAEREN', eingabe: 'bin der kevin schulz, der neue', pruefe: (r) => r.mitarbeiter.name === 'Kevin Schulz' },
  { name: 'Start mit Zeit + Baustelle', status: 'AKTIV', eingabe: 'Start 07:30 bei Müller', pruefe: (r) => r.mitarbeiter.offeneSchicht?.start === '07:30' },
  { name: 'Start Tippfehler-Baustelle', status: 'AKTIV', eingabe: 'start 8 auf kita sonenschein', pruefe: (r) => r.mitarbeiter.offeneSchicht?.baustelle === 'Kita Sonnenschein' },
  { name: 'Start ohne Baustelle -> Rückfrage', status: 'AKTIV', eingabe: 'Start 8:00', pruefe: (r) => r.mitarbeiter.pending?.typ === 'BAUSTELLE' },
  { name: 'Ende ohne Start -> Startzeit erfragen', status: 'AKTIV', eingabe: 'Feierabend', pruefe: (r) => r.mitarbeiter.pending?.typ === 'START_FEHLT' },
  { name: 'Ende schließt Schicht, Pause automatisch', status: 'AKTIV', eingabe: 'ende 16:00', vorher: (m) => (m.offeneSchicht = { datumISO: '2026-07-24', start: '07:30', baustelle: 'Müller, Dachstuhl' }), pruefe: (r) => r.buchungen[0]?.pauseMin === 30 && r.buchungen[0]?.pauseAutomatischErgaenzt === true && r.chefEvents.length === 0 },
  { name: 'Ende + Pause', status: 'AKTIV', eingabe: 'ende 16:00 mit 45 min pause', vorher: (m) => (m.offeneSchicht = { datumISO: '2026-07-24', start: '07:30', baustelle: 'Müller, Dachstuhl' }), pruefe: (r) => r.buchungen[0]?.pauseMin === 45 && !r.buchungen[0]?.pauseAutomatischErgaenzt },
  { name: 'Range 8-17, Pause automatisch ohne Rückfrage', status: 'AKTIV', eingabe: '8-17 bei praxis weber', pruefe: (r) => r.buchungen[0]?.pauseMin === 30 && r.buchungen[0]?.pauseAutomatischErgaenzt === true && r.mitarbeiter.pending == null },
  { name: 'Range mit Pause sofort gebucht', status: 'AKTIV', eingabe: 'von 8 bis 16:30 mit 30 min pause bei müller', pruefe: (r) => r.buchungen[0]?.ende === '16:30' && r.buchungen[0]?.pauseMin === 30 && !r.buchungen[0]?.pauseAutomatischErgaenzt },
  { name: 'Dezimalstunden, Pause automatisch', status: 'AKTIV', eingabe: 'heute 8,5h bei müller', pruefe: (r) => r.buchungen[0]?.pauseMin === 30 && r.buchungen[0]?.pauseAutomatischErgaenzt === true },
  { name: 'Explizit ohne Pause -> sofort gebucht + Chef-Info', status: 'AKTIV', eingabe: '8-17 ohne pause bei müller', pruefe: (r) => r.buchungen[0]?.ohnePauseBestaetigt === true && r.chefEvents.some((e) => e.typ === 'PAUSE_NICHT_GEMACHT') && r.antworten.some((a) => a.includes('nächsten Mal')) },
  { name: 'Kurzer Tag (≤6h) ohne Pause -> kein Thema', status: 'AKTIV', eingabe: '8-14 bei müller', pruefe: (r) => !r.buchungen[0]?.pauseAutomatischErgaenzt && !r.buchungen[0]?.ohnePauseBestaetigt && r.chefEvents.length === 0 },
  { name: 'Krank', status: 'AKTIV', eingabe: 'bin krank', pruefe: (r) => r.buchungen[0]?.typ === 'KRANK' },
  { name: 'Kind krank', status: 'AKTIV', eingabe: 'Kind krank heute', pruefe: (r) => r.buchungen[0]?.notiz === 'Kind krank' },
  { name: 'Urlaub', status: 'AKTIV', eingabe: 'hab frei', pruefe: (r) => r.buchungen[0]?.typ === 'URLAUB' },
  { name: 'Zeitausgleich Kürzel', status: 'AKTIV', eingabe: 'ZA', pruefe: (r) => r.buchungen[0]?.typ === 'ZEITAUSGLEICH' },
  { name: 'Nachtrag gestern', status: 'AKTIV', eingabe: 'gestern vergessen: 8 bis 16 uhr mit 30 min pause bei müller', pruefe: (r) => r.buchungen[0]?.korrektur === true && r.buchungen[0]?.datumISO === '2026-07-23' },
  { name: 'Ende vor Start -> keine Chef-Meldung, nur Tippkorrektur', status: 'AKTIV', eingabe: '17-8 bei müller', pruefe: (r) => r.buchungen.length === 0 && r.chefEvents.length === 0 && r.antworten[0].includes('vor dem Start') },
  { name: 'Über 12h -> Rückfrage statt Sackgasse', status: 'AKTIV', eingabe: '5-19 mit 30 min pause bei müller', pruefe: (r) => r.buchungen.length === 0 && r.antworten[0].includes('stimmt das') && r.mitarbeiter.pending?.typ === 'LANGER_TAG_BESTAETIGEN' },
  { name: 'Über 12h bestätigt -> gebucht + Chef-Info, Pause automatisch', status: 'AKTIV', eingabe: 'ja', vorher: (m) => (m.pending = { typ: 'LANGER_TAG_BESTAETIGEN', stunden: 13.5, entwurf: { typ: 'ARBEIT', datumISO: '2026-07-24', start: '05:00', ende: '19:00', baustelle: 'Müller, Dachstuhl' } }), pruefe: (r) => r.buchungen[0]?.pauseMin === 45 && r.buchungen[0]?.pauseAutomatischErgaenzt === true && r.chefEvents.some((e) => e.typ === 'LANGER_TAG') },
  { name: 'Sprachnachricht', status: 'AKTIV', eingabe: '', medienTyp: 'audio', pruefe: (r) => r.antworten[0].includes('Text') },
  { name: 'Stundenzettel-Foto mit Baustelle', status: 'AKTIV', eingabe: 'zettel für kita', medienTyp: 'bild', pruefe: (r) => r.belege[0]?.baustelle === 'Kita Sonnenschein' },
  { name: 'Hilfe', status: 'AKTIV', eingabe: 'Hilfe', pruefe: (r) => r.antworten[0].includes('*Start 8:00*') },
  { name: 'Eskalation nach 3 Fehlversuchen', status: 'AKTIV', eingabe: 'blubb', vorher: (m) => (m.fehlversucheInFolge = 2), pruefe: (r) => r.chefEvents.some((e) => e.typ === 'ESKALATION') },
  { name: 'DSGVO-Löschung', status: 'AKTIV', eingabe: 'ja', vorher: (m) => (m.pending = { typ: 'LOESCHEN_BESTAETIGEN' }), pruefe: (r) => r.mitarbeiter.status === 'GELOESCHT' && r.chefEvents.some((e) => e.typ === 'DATEN_GELOESCHT') },
  { name: 'Idempotenz', status: 'AKTIV', eingabe: 'krank', vorher: (m) => (m.verarbeiteteIds = ['msg-1']), pruefe: (r) => r.buchungen.length === 0 },
];

export function runTests(): void {
  let ok = 0;
  for (const tf of TESTFAELLE) {
    const m = frisch(tf.status);
    tf.vorher?.(m);
    const r = handleMitarbeiterNachricht({
      cfg: TEST_CFG, mitarbeiter: m, text: tf.eingabe,
      medienTyp: tf.medienTyp, jetzt: JETZT,
      messageId: tf.name === 'Idempotenz' ? 'msg-1' : undefined,
    });
    const bestanden = tf.pruefe(r);
    if (bestanden) ok++;
    console.log(`${bestanden ? '✅' : '❌'} ${tf.name}${bestanden ? '' : '  ->  ' + JSON.stringify(r.antworten)}`);
  }
  console.log(`\n${ok}/${TESTFAELLE.length} Testfälle bestanden.`);
}

declare const require: NodeRequire;
declare const module: { exports: unknown; id: string };
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === (module as unknown as NodeModule)) {
  runTests();
}
