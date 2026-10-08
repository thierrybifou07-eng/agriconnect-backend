import prisma from '../config/prisma.js';

// Ordre de résolution de la langue : paramètre ?lang= explicite, puis
// l'en-tête Accept-Language du navigateur, puis 'fr' par défaut.
export function resolveLocale(req) {
  const fromQuery = req.query?.lang;
  if (fromQuery === 'fr' || fromQuery === 'en') return fromQuery;

  const header = req.headers['accept-language'];
  if (header) {
    const preferred = header.split(',')[0].trim().slice(0, 2).toLowerCase();
    if (preferred === 'fr' || preferred === 'en') return preferred;
  }

  return 'fr';
}

// Retourne la version PUBLISHED d'un document, ou null.
export async function getCurrentVersion(code) {
  const document = await prisma.legalDocument.findUnique({
    where: { code },
    include: {
      versions: {
        where: { status: 'PUBLISHED' },
        orderBy: { publishedAt: 'desc' },
        take: 1,
      },
    },
  });

  return document?.versions[0] ?? null;
}

// Documents requis par rôle (RG-13).
export const REQUIRED_DOCUMENTS_BY_ROLE = {
  BUYER: ['CGU', 'BUYER_TERMS'],
  SUPPLIER: ['CGU', 'SUPPLIER_CONSIGNMENT_TERMS'],
};
