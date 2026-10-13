import prisma from '../../src/config/prisma.js';

// Textes provisoires : ils doivent être faits valider juridiquement avant
// mise en production. La marque en tête de chaque contenu le rappelle.
const PROVISIONAL = '[TEXTE PROVISOIRE — à faire valider juridiquement]';

const DOCUMENTS = [
  {
    code: 'CGU',
    label: "Conditions générales d'utilisation",
    translations: {
      fr: {
        title: "Conditions générales d'utilisation",
        content: `${PROVISIONAL}

Article 1 — Objet
Les présentes conditions générales d'utilisation régissent l'accès et l'utilisation de la plateforme AgriConnect.

Article 2 — Compte utilisateur
L'utilisateur crée un compte avec une adresse email et un mot de passe. Il est responsable de la confidentialité de ses identifiants.

Article 3 — Acceptation
L'utilisation de la plateforme implique l'acceptation pleine et entière des présentes conditions.`,
      },
      en: {
        title: "Terms of Use",
        content: `${PROVISIONAL}

Article 1 — Purpose
These terms of use govern access to and use of the AgriConnect platform.

Article 2 — User account
The user creates an account with an email address and a password. They are responsible for keeping their credentials confidential.

Article 3 — Acceptance
Use of the platform implies full acceptance of these terms.`,
      },
    },
  },
  {
    code: 'BUYER_TERMS',
    label: 'Conditions acheteurs',
    translations: {
      fr: {
        title: 'Conditions acheteurs',
        content: `${PROVISIONAL}

Article 1 — Commande
L'acheteur passe commande auprès de l'équipe AgriConnect. La commande est confirmée après validation du paiement.

Article 2 — Paiement
Le paiement est effectué au moment de la commande. Les prix sont affichés en FCFA.

Article 3 — Retrait ou livraison
L'acheteur retire sa commande au point de dépôt ou se fait livrer selon le mode choisi.`,
      },
      en: {
        title: 'Buyer Terms',
        content: `${PROVISIONAL}

Article 1 — Ordering
The buyer places an order with the AgriConnect team. The order is confirmed after payment validation.

Article 2 — Payment
Payment is made at the time of ordering. Prices are displayed in XAF.

Article 3 — Pickup or delivery
The buyer picks up their order at the depot or has it delivery according to the chosen mode.`,
      },
    },
  },
  {
    code: 'SUPPLIER_CONSIGNMENT_TERMS',
    label: 'Conditions de consignation fournisseurs',
    translations: {
      fr: {
        title: 'Conditions de consignation fournisseurs',
        content: `${PROVISIONAL}

Article 1 — Consignation sans transfert de propriété
Le fournisseur confie ses produits à AgriConnect en consignation. La propriété des produits reste celle du fournisseur jusqu'à la vente finale.

Article 2 — Prix convenu
Le prix convenu entre le fournisseur et AgriConnect est fixé à la déclaration du lot. Ce prix est ferme pendant la durée de la consignation.

Article 3 — Commission
AgriConnect prélève une commission sur chaque vente, dont le taux est défini dans les réglages de la plateforme.

Article 4 — Péremption et indemnisation
En cas de péremption ou d'invendu, le fournisseur est indemnisé selon le taux d'indemnisation en vigueur.

Article 5 — Confidentialité
Le fournisseur s'engage à ne pas contacter directement les acheteurs. Toutes les communications passent par l'équipe AgriConnect.

Article 6 — Transport et assurance
Le transport des produits est organisé par AgriConnect. Les produits sont assurés pendant la durée de la consignation.`,
      },
      en: {
        title: 'Supplier Consignment Terms',
        content: `${PROVISIONAL}

Article 1 — Consignment without transfer of ownership
The supplier entrusts their products to AgriConnect on consignment. Ownership of the products remains with the supplier until final sale.

Article 2 — Agreed price
The agreed price between the supplier and AgriConnect is set at the time of lot declaration. This price is firm for the duration of the consignment.

Article 3 — Commission
AgriConnect deducts a commission on each sale, the rate of which is defined in the platform settings.

Article 4 — Expiry and compensation
In case of expiry or unsold goods, the supplier is compensated according to the applicable compensation rate.

Article 5 — Confidentiality
The supplier agrees not to contact buyers directly. All communications go through the AgriConnect team.

Article 6 — Transport and insurance
Transport of products is organized by AgriConnect. Products are insured for the duration of the consignment.`,
      },
    },
  },
];

// Insère les documents et leur version 1.0 PUBLISHED de façon idempotente :
// si une version 1.0 existe déjà, elle n'est ni recrée ni modifiée.
export async function seedLegalDocuments() {
  for (const doc of DOCUMENTS) {
    const document = await prisma.legalDocument.upsert({
      where: { code: doc.code },
      update: {},
      create: { code: doc.code, label: doc.label },
    });

    const existing = await prisma.legalDocumentVersion.findUnique({
      where: { documentId_version: { documentId: document.id, version: '1.0' } },
    });

    if (existing) continue;

    await prisma.legalDocumentVersion.create({
      data: {
        documentId: document.id,
        version: '1.0',
        status: 'PUBLISHED',
        publishedAt: new Date(),
        translations: {
          create: [
            { locale: 'fr', title: doc.translations.fr.title, content: doc.translations.fr.content },
            { locale: 'en', title: doc.translations.en.title, content: doc.translations.en.content },
          ],
        },
      },
    });
  }
}
