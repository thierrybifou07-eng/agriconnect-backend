import prisma from '../../config/prisma.js';
import { listingToBuyerDto } from '../../utils/dto/listing.dto.js';
import { lotToSupplierDto } from '../../utils/dto/lot.dto.js';
import { PLATFORM_FACTS_FR } from './ai.facts.js';

const normalizeNumber = (value) => String(value).replace(/[\s,]/g, '').replace(/[.]+$/, '');

function addNumbers(target, value) {
  if (value === null || value === undefined) return;
  if (value instanceof Date || value?.toISOString) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      target.add(String(date.getUTCFullYear()));
      target.add(String(date.getUTCMonth() + 1));
      target.add(String(date.getUTCDate()));
      target.add(`${date.getUTCDate()}/${date.getUTCMonth() + 1}/${date.getUTCFullYear()}`);
    }
    return;
  }
  if (typeof value === 'number' || typeof value === 'string') {
    const text = String(value);
    for (const match of text.matchAll(/\d[\d\s.,]*/g)) {
      const normalized = normalizeNumber(match[0].trim());
      if (normalized) target.add(normalized);
    }
  }
}

function getBuyerListingInclude() {
  return {
    product: { include: { category: true, unit: true } },
    zone: true,
    media: { select: { url: true, position: true, isPrimary: true } },
    lots: {
      select: {
        lot: {
          select: {
            quantityAvailable: true,
            expiresAt: true,
            qualityGrade: true,
          },
        },
      },
    },
  };
}

export async function buildReplyContext(conversationId) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      messages: {
        where: { isInternal: false },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { senderType: true, content: true, createdAt: true },
      },
    },
  });
  if (!conversation) {
    const error = new Error('Conversation introuvable');
    error.code = 'CONVERSATION_NOT_FOUND';
    throw error;
  }

  const history = conversation.messages
    .reverse()
    .map((message) => ({
      role: message.senderType === 'CUSTOMER' ? 'client' : 'equipe',
      text: message.content,
    }));
  const allowedNumbers = new Set();
  let facts = PLATFORM_FACTS_FR;

  if (conversation.type === 'BUYER_SUPPORT' && conversation.listingId) {
    const listing = await prisma.listing.findFirst({
      where: { id: conversation.listingId, status: { code: 'ACTIVE' } },
      include: getBuyerListingInclude(),
    });
    if (listing) {
      const publicListing = listingToBuyerDto(listing);
      facts += ` Annonce publique : ${JSON.stringify(publicListing)}.`;
      addNumbers(allowedNumbers, publicListing.unitPrice);
      addNumbers(allowedNumbers, publicListing.quantityAvailable);
      addNumbers(allowedNumbers, publicListing.expiresAt);
      for (const lotLink of listing.lots) {
        addNumbers(allowedNumbers, lotLink.lot.quantityAvailable);
        addNumbers(allowedNumbers, lotLink.lot.expiresAt);
      }
    }
  }

  if (conversation.type === 'SUPPLIER_SUPPORT' && conversation.lotId) {
    const lot = await prisma.stockLot.findFirst({
      where: { id: conversation.lotId, supplier: { userId: conversation.customerId } },
      include: {
        product: { include: { category: true, unit: true } },
        zone: true,
        hub: true,
        media: true,
      },
    });
    if (lot) {
      const supplierLot = lotToSupplierDto(lot);
      const privateLotSummary = {
        product: supplierLot.product,
        zone: supplierLot.zone,
        status: supplierLot.status,
        agreedUnitPrice: supplierLot.agreedUnitPrice,
        quantityInitial: supplierLot.quantityInitial,
        quantityAvailable: supplierLot.quantityAvailable,
        quantityReserved: supplierLot.quantityReserved,
        quantitySold: supplierLot.quantitySold,
        expiresAt: supplierLot.expiresAt,
      };
      facts += ` Résumé du lot du fournisseur connecté : ${JSON.stringify(privateLotSummary)}.`;
      addNumbers(allowedNumbers, privateLotSummary.agreedUnitPrice);
      addNumbers(allowedNumbers, privateLotSummary.quantityInitial);
      addNumbers(allowedNumbers, privateLotSummary.quantityAvailable);
      addNumbers(allowedNumbers, privateLotSummary.quantityReserved);
      addNumbers(allowedNumbers, privateLotSummary.quantitySold);
      addNumbers(allowedNumbers, privateLotSummary.expiresAt);
    }
  }

  return { facts, allowedNumbers, history };
}

export async function buildListingDraftContext(lotId) {
  const lot = await prisma.stockLot.findUnique({
    where: { id: lotId },
    select: {
      product: { select: {
        name: true,
        description: true,
        category: { select: { label: true } },
        unit: { select: { label: true } },
      } },
      quantityAvailable: true,
      qualityGrade: true,
      harvestedAt: true,
      expiresAt: true,
      packagingNote: true,
      qualityNote: true,
    },
  });
  if (!lot) {
    const error = new Error('Lot introuvable');
    error.code = 'LOT_NOT_FOUND';
    throw error;
  }
  const facts = {
    product: lot.product.name,
    productDescription: lot.product.description,
    category: lot.product.category.label,
    unit: lot.product.unit.label,
    quantityAvailable: lot.quantityAvailable,
    qualityGrade: lot.qualityGrade,
    harvestedAt: lot.harvestedAt,
    expiresAt: lot.expiresAt,
    packagingNote: lot.packagingNote,
    qualityNote: lot.qualityNote,
  };
  const allowedNumbers = new Set();
  for (const value of Object.values(facts)) addNumbers(allowedNumbers, value);
  return { facts: JSON.stringify(facts), allowedNumbers };
}
