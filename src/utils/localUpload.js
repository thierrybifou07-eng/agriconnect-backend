import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Résolution des chemins
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dossier racine uploads/ à la racine du projet (deux niveaux au-dessus de
// src/utils/).
export const UPLOADS_ROOT = join(__dirname, '..', '..', 'uploads');

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

// Correspondance mimetype → extension de fichier.
const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

// Correspondance dossier Cloudinary → sous-dossier local.
// Les valeurs de l'enum Prisma DocumentType (ID_CARD, BUSINESS_REGISTRATION,
// FARM_PROOF, OTHER) servent directement de sous-dossiers pour les documents
// de vérification.
const FOLDER_MAP = {
  'agriconnect/lots': 'LOT_PHOTO',
  'agriconnect/listings': 'LISTING_PHOTO',
  // 'agriconnect/verification-documents' → résolu dynamiquement via documentType
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Génère un nom de fichier unique et traçable.
 *
 * Format : {YYYYMMDD}T{HHMMSS}_{userId}_{rand8}{ext}
 * Exemple : 20261018T142300_42_aB3xKpQm.jpg
 *
 * - Date/heure UTC compacte pour identification immédiate de l'upload.
 * - userId : identifiant de l'utilisateur propriétaire du contenu.
 * - rand8  : 8 caractères base64url via crypto.randomBytes (natif Node.js,
 *            aucune dépendance supplémentaire) pour unicité garantie même à
 *            haute concurrence.
 */
function buildFileName(userId, mimetype) {
  const now = new Date();
  // Format ISO compact : 20261018T142300
  const date =
    now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, '0') +
    String(now.getUTCDate()).padStart(2, '0') +
    'T' +
    String(now.getUTCHours()).padStart(2, '0') +
    String(now.getUTCMinutes()).padStart(2, '0') +
    String(now.getUTCSeconds()).padStart(2, '0');

  const rand = randomBytes(6).toString('base64url').slice(0, 8);
  const ext = MIME_TO_EXT[mimetype] ?? '.bin';

  return `${date}_${userId}_${rand}${ext}`;
}

/**
 * Détermine le sous-dossier de destination à partir des options.
 *
 * - Pas de dossier spécifié → AVATAR (avatar utilisateur)
 * - 'agriconnect/lots'      → LOT_PHOTO
 * - 'agriconnect/listings'  → LISTING_PHOTO
 * - 'agriconnect/verification-documents' → valeur de options.documentType
 *   (ID_CARD | BUSINESS_REGISTRATION | FARM_PROOF | OTHER)
 */
function resolveSubFolder(options) {
  const { folder, documentType } = options;

  if (!folder) return 'AVATAR';

  if (folder === 'agriconnect/verification-documents') {
    // documentType correspond exactement aux codes de l'enum Prisma DocumentType.
    // Fallback sur 'OTHER' si absent (ne devrait pas arriver en production).
    return documentType ?? 'OTHER';
  }

  return FOLDER_MAP[folder] ?? 'OTHER';
}

// ---------------------------------------------------------------------------
// Export principal
// ---------------------------------------------------------------------------

/**
 * Écrit un buffer en mémoire dans le système de fichiers local.
 *
 * Signature identique à l'ancienne uploadBufferToCloudinary, afin que le
 * shim cloudinaryUpload.js reste transparent pour tous les contrôleurs.
 *
 * Options reconnues (en plus des options historiques) :
 *   - userId      {number}  ID de l'utilisateur propriétaire du contenu
 *   - mimetype    {string}  MIME type du fichier (détermine l'extension)
 *   - documentType {string} Valeur DocumentType Prisma pour les documents de
 *                           vérification (ID_CARD, BUSINESS_REGISTRATION, …)
 *
 * Modes de retour (identiques à l'ancienne fonction) :
 *   - mode simple   → string (URL relative publique)
 *   - mode public_id (withPublicId: true ou type: 'authenticated')
 *     → { url: string, public_id: string }
 *
 * L'URL retournée est une URL relative au serveur : /uploads/{sous-dossier}/{fichier}.
 * Le public_id est le chemin relatif au dossier uploads/ : {sous-dossier}/{fichier}.
 * Ce public_id est stocké en base (Media.publicId) et utilisé pour générer
 * les tokens JWT d'accès sécurisé aux documents privés.
 */
export function uploadFileLocally(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const isPrivate = options.type === 'authenticated';
      const avecPublicId = options.withPublicId === true || isPrivate;

      const userId = options.userId ?? 0;
      const mimetype = options.mimetype ?? 'application/octet-stream';

      const subFolder = resolveSubFolder(options);
      const fileName = buildFileName(userId, mimetype);
      const targetDir = join(UPLOADS_ROOT, subFolder);

      // Crée le dossier s'il n'existe pas encore (premier upload dans ce
      // dossier). recursive: true évite l'erreur si le dossier existe déjà.
      mkdirSync(targetDir, { recursive: true });

      writeFileSync(join(targetDir, fileName), buffer);

      const url = `/uploads/${subFolder}/${fileName}`;
      const publicId = `${subFolder}/${fileName}`;

      if (avecPublicId) {
        resolve({ url, public_id: publicId });
      } else {
        resolve(url);
      }
    } catch (err) {
      reject(err);
    }
  });
}
