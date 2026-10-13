import prisma from '../config/prisma.js';
import { resolveLocale, getCurrentVersion } from '../utils/legal.js';

// GET /api/v2/legal — liste des documents courants avec leur version publiée.
export const listLegalDocuments = async (req, res) => {
  const documents = await prisma.legalDocument.findMany({
    include: {
      versions: {
        where: { status: 'PUBLISHED' },
        orderBy: { publishedAt: 'desc' },
        take: 1,
      },
    },
    orderBy: { code: 'asc' },
  });

  const items = documents.map((doc) => {
    const current = doc.versions[0];
    return {
      code: doc.code,
      label: doc.label,
      version: current?.version ?? null,
      publishedAt: current?.publishedAt ?? null,
    };
  });

  res.json(items);
};

// GET /api/v2/legal/:code?lang= — contenu d'un document dans la langue demandée.
// Repli sur 'fr' si la traduction demandée n'existe pas ; le champ locale
// renvoyé indique la langue réellement servie.
export const getLegalDocument = async (req, res) => {
  const { code } = req.params;
  const version = await getCurrentVersion(code);

  if (!version) {
    return res.status(404).json({ error: 'Document introuvable ou non publié' });
  }

  const requestedLocale = resolveLocale(req);
  const translations = await prisma.legalDocumentTranslation.findMany({
    where: { versionId: version.id },
  });

  const requested = translations.find((t) => t.locale === requestedLocale);
  const fallback = translations.find((t) => t.locale === 'fr');
  const translation = requested ?? fallback;

  // Sans traduction fr en secours, la version est inexploitable : 404.
  if (!translation) {
    return res.status(404).json({ error: 'Document introuvable ou non publié' });
  }

  res.json({
    code,
    version: version.version,
    locale: translation.locale,
    title: translation.title,
    content: translation.content,
    publishedAt: version.publishedAt,
  });
};

// POST /api/v2/admin/legal/:code/versions — crée une version DRAFT.
export const createLegalVersion = async (req, res) => {
  const { code } = req.params;
  const { version: versionNumber, translations } = req.body;

  const document = await prisma.legalDocument.findUnique({ where: { code } });
  if (!document) {
    return res.status(404).json({ error: 'Document introuvable' });
  }

  const existing = await prisma.legalDocumentVersion.findUnique({
    where: { documentId_version: { documentId: document.id, version: versionNumber } },
  });
  if (existing) {
    return res.status(409).json({ error: 'Cette version existe déjà pour ce document' });
  }

  const created = await prisma.legalDocumentVersion.create({
    data: {
      documentId: document.id,
      version: versionNumber,
      status: 'DRAFT',
      translations: {
        create: translations.map((t) => ({
          locale: t.locale,
          title: t.title,
          content: t.content,
        })),
      },
    },
    include: { translations: true },
  });

  res.status(201).json(created);
};

// PATCH /api/v2/admin/legal/versions/:id/publish — publie une version et archive
// la précédente version publiée du même document, dans une transaction.
export const publishLegalVersion = async (req, res) => {
  const { id } = req.params;

  const target = await prisma.legalDocumentVersion.findUnique({
    where: { id },
    include: { document: true },
  });

  if (!target) {
    return res.status(404).json({ error: 'Version introuvable' });
  }
  if (target.status === 'PUBLISHED') {
    return res.status(409).json({ error: 'Cette version est déjà publiée' });
  }

  const now = new Date();

  const [published] = await prisma.$transaction([
    prisma.legalDocumentVersion.update({
      where: { id: target.id },
      data: { status: 'PUBLISHED', publishedAt: now },
    }),
    prisma.legalDocumentVersion.updateMany({
      where: {
        documentId: target.documentId,
        status: 'PUBLISHED',
        id: { not: target.id },
      },
      data: { status: 'ARCHIVED' },
    }),
  ]);

  res.json(published);
};
