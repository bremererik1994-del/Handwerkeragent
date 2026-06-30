import prisma from '../../db';
import { getWhatsAppProvider } from '../whatsapp';
import type { Employee } from '@prisma/client';

export async function handleLocationReportIntent(
  employee: Employee,
  reportType: string,
  data: Record<string, unknown>,
  mediaUrl?: string,
  rawText?: string,
) {
  // Find the employee's active location assignment
  const assignment = await prisma.locationAssignment.findFirst({
    where: { employeeId: employee.id },
    include: { location: true },
  });

  // If no assignment, try to find the company's only active location
  let locationId = assignment?.locationId;
  if (!locationId) {
    const locations = await prisma.location.findMany({
      where: { companyId: employee.companyId, status: 'AKTIV' },
    });
    if (locations.length === 1) locationId = locations[0].id;
  }

  if (!locationId) {
    console.warn('[Location] cannot resolve location for employee:', employee.id);
    return;
  }

  if (reportType === 'FOTO' && mediaUrl) {
    await prisma.locationMedia.create({
      data: {
        locationId,
        employeeId: employee.id,
        url: mediaUrl,
        mediaType: 'image',
        caption: rawText ?? '',
      },
    });

    const wa = getWhatsAppProvider();
    await wa.sendMessage({
      to: employee.phone,
      text: '📸 Foto wurde gespeichert und dem Standort zugeordnet.',
    });
    return;
  }

  await prisma.locationReport.create({
    data: {
      locationId,
      employeeId: employee.id,
      reportType,
      content: rawText ?? '',
      data: data as unknown as any,
    },
  });

  const wa = getWhatsAppProvider();
  const confirmations: Record<string, string> = {
    LAGER: '📦 Lagermeldung erfasst. Der Inhaber wird informiert.',
    UMSATZ: '💰 Umsatzmeldung erfasst.',
    KASSENABSCHLUSS: '🧾 Kassenabschluss erfasst.',
  };
  await wa.sendMessage({
    to: employee.phone,
    text: confirmations[reportType] ?? '✅ Meldung erfasst.',
  });
}
