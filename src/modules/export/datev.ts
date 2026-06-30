import * as XLSX from 'xlsx';
import PDFDocument from 'pdfkit';
import type { Response } from 'express';
import type { PayrollSummary } from '../payroll/service';

// ─── DATEV Lohn & Gehalt – Arbeitszeitnachweis CSV ───────────────────────────
// Semicolon-delimited, German decimal notation (Komma), UTF-8 with BOM
// Suitable as import template for DATEV Lohn und Gehalt / Steuerberater handoff
export function exportDatevCsv(summaries: PayrollSummary[]): string {
  const header = [
    'Personalnummer',
    'Mitarbeiter',
    'Beschäftigungsart',
    'Zeitraum von',
    'Zeitraum bis',
    // Arbeitsstunden
    'Sollstunden',
    'Ist-Stunden (regulär)',
    'Überstunden',
    'Nachtstunden',
    'Sonntagsstunden',
    'Feiertagsstunden',
    'Gesamtstunden',
    // Abwesenheiten
    'Kranktage',
    'Urlaubstage',
    'Zeitausgleich Tage',
    'Sonderurlaub Tage',
    // Vergütung
    'Stundenansatz €',
    'Bruttogrundlohn €',
    'Überstundenzuschlag €',
    'Nachtzuschlag €',
    'Sonntagszuschlag €',
    'Feiertagszuschlag €',
    'Gesamtbrutto €',
    'Minijob-Warnung',
    'Hinweis',
  ].join(';');

  const rows = summaries.map((s, i) =>
    [
      String(i + 1).padStart(4, '0'), // Personalnummer (Platzhalter – bitte mit DATEV-Nr. ersetzen)
      s.employeeName,
      s.employmentType,
      s.periodFrom,
      s.periodTo,
      '',                                                          // Sollstunden – vom Steuerberater zu ergänzen
      fmt(s.regularMinutes / 60),
      fmt(s.overtimeMinutes / 60),
      fmt(s.nightMinutes / 60),
      fmt(s.sundayMinutes / 60),
      fmt(s.holidayMinutes / 60),
      fmt(s.totalWorkedMinutes / 60),
      String(s.kranktage),
      String(s.urlaubstage),
      String(s.zeitausgleichtage),
      String(s.sonderurlaubtage),
      fmt(0),                                                      // Stundenansatz – aus DATEV befüllen
      fmt(s.regularGross),
      fmt(s.overtimeGross),
      fmt(s.nightSurcharge),
      fmt(s.sundaySurcharge),
      fmt(s.holidaySurcharge),
      fmt(s.totalGross),
      s.minijobLimitWarning ? 'JA' : 'NEIN',
      'Lohnvorbereitung – keine rechtsverbindliche Abrechnung',
    ].join(';'),
  );

  return [header, ...rows].join('\r\n');
}

// ─── Lexware Lohn & Gehalt – Lohnarten CSV ───────────────────────────────────
// Lexware kann Lohnarten per CSV importieren.
// Format: Personalnummer;Lohnart;Bezeichnung;Menge;Einheit;Betrag
// Standard-Lohnarten (anpassbar in Lexware unter Lohnarten-Stammdaten):
//   100 = Reguläre Stunden, 110 = Überstunden, 120 = Nachtstunden
//   130 = Sonntagsstunden, 140 = Feiertagsstunden
//   200 = Kranktage (Lohnfortzahlung), 210 = Urlaubstage
//   220 = Zeitausgleich, 230 = Sonderurlaub
export function exportLexwareCsv(summaries: PayrollSummary[]): string {
  const header = 'Personalnummer;Lohnart;Bezeichnung;Menge;Einheit;Betrag';

  const rows: string[] = [];

  summaries.forEach((s, i) => {
    const pnr = String(i + 1).padStart(4, '0');
    const add = (lohnart: string, bezeichnung: string, menge: number, einheit: string, betrag: number) => {
      if (menge === 0 && betrag === 0) return;
      rows.push([pnr, lohnart, bezeichnung, fmt(menge), einheit, fmt(betrag)].join(';'));
    };

    add('100', 'Reguläre Stunden',    s.regularMinutes / 60,   'Std', s.regularGross);
    add('110', 'Überstunden',         s.overtimeMinutes / 60,  'Std', s.overtimeGross);
    add('120', 'Nachtstunden',        s.nightMinutes / 60,     'Std', s.nightSurcharge);
    add('130', 'Sonntagsstunden',     s.sundayMinutes / 60,    'Std', s.sundaySurcharge);
    add('140', 'Feiertagsstunden',    s.holidayMinutes / 60,   'Std', s.holidaySurcharge);
    add('200', 'Kranktage (§3 EFZG)', s.kranktage,            'Tage', 0);
    add('210', 'Urlaubstage',         s.urlaubstage,           'Tage', 0);
    add('220', 'Zeitausgleich',       s.zeitausgleichtage,     'Tage', 0);
    add('230', 'Sonderurlaub',        s.sonderurlaubtage,      'Tage', 0);
  });

  return [header, ...rows].join('\r\n');
}

// ─── XLSX (Lexware / sevDesk / Steuerberater) ─────────────────────────────────
export function exportXlsx(summaries: PayrollSummary[]): Buffer {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Lohnübersicht
  const ws1 = XLSX.utils.json_to_sheet(
    summaries.map((s, i) => ({
      'Personalnummer': String(i + 1).padStart(4, '0'),
      'Mitarbeiter': s.employeeName,
      'Beschäftigungsart': s.employmentType,
      'Zeitraum von': s.periodFrom,
      'Zeitraum bis': s.periodTo,
      'Reguläre Std.': round2(s.regularMinutes / 60),
      'Überstunden Std.': round2(s.overtimeMinutes / 60),
      'Nachtstunden Std.': round2(s.nightMinutes / 60),
      'Sonntagsstunden Std.': round2(s.sundayMinutes / 60),
      'Feiertagsstunden Std.': round2(s.holidayMinutes / 60),
      'Gesamtstunden': round2(s.totalWorkedMinutes / 60),
      'Bruttogrundlohn €': round2(s.regularGross),
      'Überstundenzuschlag €': round2(s.overtimeGross),
      'Nachtzuschlag €': round2(s.nightSurcharge),
      'Sonntagszuschlag €': round2(s.sundaySurcharge),
      'Feiertagszuschlag €': round2(s.holidaySurcharge),
      'Gesamtbrutto €': round2(s.totalGross),
      'Minijob-Warnung': s.minijobLimitWarning ? 'JA' : '-',
    })),
  );
  XLSX.utils.sheet_add_aoa(ws1, [[''], [summaries[0]?.disclaimer ?? '']], { origin: -1 });
  XLSX.utils.book_append_sheet(wb, ws1, 'Lohnübersicht');

  // Sheet 2: Abwesenheiten
  const ws2 = XLSX.utils.json_to_sheet(
    summaries.map((s, i) => ({
      'Personalnummer': String(i + 1).padStart(4, '0'),
      'Mitarbeiter': s.employeeName,
      'Zeitraum von': s.periodFrom,
      'Zeitraum bis': s.periodTo,
      'Kranktage': s.kranktage,
      'Urlaubstage': s.urlaubstage,
      'Zeitausgleich Tage': s.zeitausgleichtage,
      'Sonderurlaub Tage': s.sonderurlaubtage,
      'Hinweis': s.kranktage > 0 ? 'AU-Bescheinigung anfordern' : '',
    })),
  );
  XLSX.utils.book_append_sheet(wb, ws2, 'Abwesenheiten');

  // Sheet 3: Lexware Lohnarten (direkt importierbar)
  const lexwareRows: object[] = [];
  summaries.forEach((s, i) => {
    const pnr = String(i + 1).padStart(4, '0');
    const add = (lohnart: string, bezeichnung: string, menge: number, einheit: string, betrag: number) => {
      if (menge === 0 && betrag === 0) return;
      lexwareRows.push({ Personalnummer: pnr, Lohnart: lohnart, Bezeichnung: bezeichnung, Menge: round2(menge), Einheit: einheit, 'Betrag €': round2(betrag) });
    };
    add('100', 'Reguläre Stunden',    s.regularMinutes / 60,  'Std', s.regularGross);
    add('110', 'Überstunden',         s.overtimeMinutes / 60, 'Std', s.overtimeGross);
    add('120', 'Nachtstunden',        s.nightMinutes / 60,    'Std', s.nightSurcharge);
    add('130', 'Sonntagsstunden',     s.sundayMinutes / 60,   'Std', s.sundaySurcharge);
    add('140', 'Feiertagsstunden',    s.holidayMinutes / 60,  'Std', s.holidaySurcharge);
    add('200', 'Kranktage',           s.kranktage,            'Tage', 0);
    add('210', 'Urlaubstage',         s.urlaubstage,          'Tage', 0);
    add('220', 'Zeitausgleich',       s.zeitausgleichtage,    'Tage', 0);
    add('230', 'Sonderurlaub',        s.sonderurlaubtage,     'Tage', 0);
  });
  if (lexwareRows.length > 0) {
    const ws3 = XLSX.utils.json_to_sheet(lexwareRows);
    XLSX.utils.book_append_sheet(wb, ws3, 'Lexware-Import');
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ─── PDF ──────────────────────────────────────────────────────────────────────
export function streamPayrollPdf(summary: PayrollSummary, res: Response) {
  const doc = new PDFDocument({ margin: 50 });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="lohnvorbereitung_${summary.employeeName.replace(/\s+/g, '_')}.pdf"`,
  );
  doc.pipe(res);

  // Header
  doc.fontSize(18).font('Helvetica-Bold').text('ZeitPilot – Lohnvorbereitung', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica').fillColor('gray')
    .text('Kompatibel mit DATEV Lohn & Gehalt und Lexware Lohnabrechnung', { align: 'center' });
  doc.fillColor('black').moveDown(0.8);

  doc.fontSize(12).font('Helvetica').text(`Mitarbeiter:        ${summary.employeeName}`);
  doc.text(`Beschäftigungsart: ${summary.employmentType}`);
  doc.text(`Zeitraum:          ${summary.periodFrom} – ${summary.periodTo}`);
  doc.moveDown();

  // Arbeitsstunden
  doc.font('Helvetica-Bold').fontSize(13).text('Arbeitsstunden', { underline: true });
  doc.font('Helvetica').fontSize(11);
  doc.text(`Reguläre Stunden:       ${(summary.regularMinutes / 60).toFixed(2)} h`);
  doc.text(`Überstunden:            ${(summary.overtimeMinutes / 60).toFixed(2)} h`);
  doc.text(`Nachtstunden:           ${(summary.nightMinutes / 60).toFixed(2)} h`);
  doc.text(`Sonntagsstunden:        ${(summary.sundayMinutes / 60).toFixed(2)} h`);
  doc.text(`Feiertagsstunden:       ${(summary.holidayMinutes / 60).toFixed(2)} h`);
  doc.font('Helvetica-Bold').text(`Gesamtstunden:          ${(summary.totalWorkedMinutes / 60).toFixed(2)} h`);
  doc.moveDown();

  // Abwesenheiten
  doc.font('Helvetica-Bold').fontSize(13).text('Abwesenheiten (lohnrelevant)', { underline: true });
  doc.font('Helvetica').fontSize(11);
  doc.text(`Kranktage:              ${summary.kranktage} Tage${summary.kranktage > 0 ? '  ← AU-Bescheinigung anfordern' : ''}`);
  doc.text(`Urlaubstage:            ${summary.urlaubstage} Tage`);
  doc.text(`Zeitausgleich:          ${summary.zeitausgleichtage} Tage`);
  doc.text(`Sonderurlaub:           ${summary.sonderurlaubtage} Tage`);
  doc.moveDown();

  // Vergütung
  doc.font('Helvetica-Bold').fontSize(13).text('Vergütungsübersicht (Schätzung)', { underline: true });
  doc.font('Helvetica').fontSize(11);
  doc.text(`Bruttogrundlohn:        ${summary.regularGross.toFixed(2)} €`);
  doc.text(`Überstundenzuschlag:    ${summary.overtimeGross.toFixed(2)} €`);
  doc.text(`Nachtzuschlag:          ${summary.nightSurcharge.toFixed(2)} €`);
  doc.text(`Sonntagszuschlag:       ${summary.sundaySurcharge.toFixed(2)} €`);
  doc.text(`Feiertagszuschlag:      ${summary.holidaySurcharge.toFixed(2)} €`);
  doc.font('Helvetica-Bold').text(`Gesamtbrutto:           ${summary.totalGross.toFixed(2)} €`);
  doc.moveDown();

  // Lexware Lohnarten Kurzübersicht
  doc.font('Helvetica-Bold').fontSize(13).text('Lexware / DATEV Lohnarten', { underline: true });
  doc.font('Helvetica').fontSize(10);
  const lohnarten = [
    ['100', 'Reguläre Stunden', `${(summary.regularMinutes / 60).toFixed(2)} Std`],
    ['110', 'Überstunden', `${(summary.overtimeMinutes / 60).toFixed(2)} Std`],
    ['120', 'Nachtstunden', `${(summary.nightMinutes / 60).toFixed(2)} Std`],
    ['200', 'Kranktage', `${summary.kranktage} Tage`],
    ['210', 'Urlaubstage', `${summary.urlaubstage} Tage`],
    ['220', 'Zeitausgleich', `${summary.zeitausgleichtage} Tage`],
    ['230', 'Sonderurlaub', `${summary.sonderurlaubtage} Tage`],
  ];
  lohnarten.forEach(([code, name, menge]) => {
    doc.text(`  LA ${code}  ${name.padEnd(22)} ${menge}`);
  });
  doc.moveDown();

  if (summary.minijobLimitWarning) {
    doc.fillColor('red').font('Helvetica-Bold').fontSize(11)
      .text(`⚠ Minijob-Warnung: Geschätzte Einnahmen nähern sich der Grenze von ${summary.minijobMonthlyLimit} €!`);
    doc.fillColor('black').font('Helvetica');
    doc.moveDown();
  }

  doc.fontSize(8).fillColor('gray').text(summary.disclaimer);
  doc.end();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(n: number): string {
  return n.toFixed(2).replace('.', ',');
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
