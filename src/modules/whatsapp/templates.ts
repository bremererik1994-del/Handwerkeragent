/**
 * WhatsApp Message Templates
 *
 * Templates marked with requiresApproval=true must be submitted to Meta for pre-approval
 * before use in production (required for all outbound "cold" messages).
 *
 * Template names here correspond to approved template names in the Meta Business Manager.
 * In development (MockProvider) they are logged only.
 */
export const WA_TEMPLATES = {
  // Sent when supervisor adds a new employee
  EMPLOYEE_INVITE: {
    name: 'zeitpilot_employee_invite',
    language: 'de',
    requiresApproval: true,
    description: 'Erstkontakt / Opt-in Einladung an neuen Mitarbeiter',
  },

  // Reminder if employee hasn't responded after 24h
  ONBOARDING_REMINDER: {
    name: 'zeitpilot_onboarding_reminder',
    language: 'de',
    requiresApproval: true,
    description: 'Erinnerung falls Opt-in nach 24h aussteht',
  },

  // Weekly time summary sent to employee
  WEEKLY_SUMMARY: {
    name: 'zeitpilot_weekly_summary',
    language: 'de',
    requiresApproval: true,
    description: 'Wochenübersicht Arbeitszeiten',
  },

  // Cash register close reminder (Einzelhandel)
  KASSENABSCHLUSS_REMINDER: {
    name: 'zeitpilot_kassenabschluss',
    language: 'de',
    requiresApproval: true,
    description: 'Erinnerung Kassenabschluss am Ende der Schicht',
  },
} as const;

export type TemplateName = keyof typeof WA_TEMPLATES;
