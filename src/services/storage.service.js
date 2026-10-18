import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Résolution des chemins
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dossier racine uploads/ : variable d'environnement UPLOADS_DIR si présente,
// sinon <racine projet>/uploads (deux niveaux au-dessus de src/services/).
export const UPLOADS_ROOT = process.env.UPLOADS_DIR
  ? join(process.env.UPLOADS_DIR)
  : join(__dirname, '..', '..', 'uploads');

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

// Types de stockage. La valeur sert de sous-dossier dans uploads/, sauf
// VERIFICATION_DOCUMENT qui route vers un sous-dossier portant le documentType.
export const StorageKind = {
  AVATAR: 'AVATAR',
  LOT_PHOTO: 'LOT_PHOTO',
  LISTING_PHOTO: 'LISTING_PHOTO',
  VERIFICATION_DOCUMENT: 'VERIFICATION_DOCUMENT',
};

// Source unique des dossiers servis statiquement (boucle dans app.js).
export const PUBLIC_KINDS = ['AVATAR', 'LOT_PHOTO', 'LISTING_PHOTO'];

// Sous-dossiers privés : valeurs de l'enum Prisma DocumentType, utilisées
// directement comme sous-dossiers pour les documents de vérification. Ces
// dossiers ne sont PAS montés statiquement : l'accès passe par
// GET /api/v2/admin/files/:token (token JWT signé, exp. 10 min).
const PRIVATE_FOLDERS = ['ID_CARD', 'BUSINESS_REGISTRATION', 'FARM_PROOF', 'OTHER'];

// Correspondance mimetype → extension de fichier.
const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
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
 * Vérifie qu'un publicId est un chemin relatif restant sous UPLOADS_ROOT.
 *
 * Refuse les chemins absolus et les remontées ('..') : un publicId malveillant
 * ne doit jamais sortir du dossier uploads/.
 *
 * @returns {string} le chemin relatif normalisé (séparateurs natifs).
 * @throws {Error} si le publicId est invalide ou sort de la racine.
 */
function assertSafeRelativePath(publicId) {
  if (typeof publicId !== 'string' || publicId.length === 0) {
    throw new Error('Identifiant de fichier invalide');
  }
  if (isAbsolute(publicId)) {
    throw new Error('Identifiant de fichier invalide');
  }
  const rel = relative(UPLOADS_ROOT, join(UPLOADS_ROOT, publicId));
  if (rel.startsWith('..')) {
    throw new Error('Identifiant de fichier invalide');
  }
  return rel;
}

// ---------------------------------------------------------------------------
// Export principal
// ---------------------------------------------------------------------------

/**
 * Écrit un buffer en mémoire dans le système de fichiers local.
 *
 * Options :
 *   - kind         {string}  Obligatoire. Valeur de StorageKind.
 *   - userId       {number}  ID de l'utilisateur propriétaire du contenu.
 *   - mimetype     {string}  MIME type du fichier (détermine l'extension).
 *   - documentType {string}  Obligatoire pour VERIFICATION_DOCUMENT : valeur
 *                             DocumentType Prisma (ID_CARD,
 *                             BUSINESS_REGISTRATION, FARM_PROOF, OTHER).
 *
 * Retour (toujours le même objet) :
 *   - url       {string} URL relative publique /uploads/{sous-dossier}/{fichier}
 *   - publicId  {string} Chemin relatif à la racine uploads/ (stocké en base
 *                dans Media.publicId).
 *   - isPrivate {boolean} true pour les documents de vérification.
 *   - size      {number} Taille du fichier en octets.
 */
export async function saveFile(
  buffer,
  { kind, userId = 0, mimetype = 'application/octet-stream', documentType } = {}
) {
  let subFolder;
  let isPrivate;

  switch (kind) {
    case StorageKind.AVATAR:
    case StorageKind.LOT_PHOTO:
    case StorageKind.LISTING_PHOTO:
      subFolder = kind;
      isPrivate = false;
      break;
    case StorageKind.VERIFICATION_DOCUMENT:
      // documentType correspond exactement aux codes de l'enum Prisma
      // DocumentType et sert directement de sous-dossier : pas de fallback
      // silencieux, un type inconnu est une erreur.
      if (!documentType || !PRIVATE_FOLDERS.includes(documentType)) {
        throw new Error('Type de document invalide');
      }
      subFolder = documentType;
      isPrivate = true;
      break;
    default:
      throw new Error('Type de stockage invalide');
  }

  const fileName = buildFileName(userId, mimetype);
  const targetDir = join(UPLOADS_ROOT, subFolder);

  // Crée le dossier s'il n'existe pas encore (premier upload dans ce
  // dossier). recursive: true évite l'erreur si le dossier existe déjà.
  await mkdir(targetDir, { recursive: true });
  await writeFile(join(targetDir, fileName), buffer);

  const publicId = `${subFolder}/${fileName}`;
  const url = `/uploads/${publicId}`;

  return { url, publicId, isPrivate, size: buffer.length };
}

/**
 * Supprime un fichier du dossier uploads/. Idempotent : un fichier déjà
 * absent (ENOENT) ne lève aucune erreur. Tout publicId sortant de la racine
 * est refusé.
 */
export async function deleteFile(publicId) {
  const rel = assertSafeRelativePath(publicId);
  try {
    await unlink(join(UPLOADS_ROOT, rel));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/**
 * Renvoie le chemin absolu d'un fichier privé (document de vérification).
 *
 * @throws {Error} si le publicId n'est pas dans un dossier privé ou sort de
 *                 la racine.
 */
export function resolvePrivateFile(publicId) {
  const rel = assertSafeRelativePath(publicId);
  // Le publicId est un chemin relatif en '/' : le premier segment est le
  // sous-dossier, qui doit être un dossier privé.
  const subFolder = publicId.split('/')[0];
  if (!PRIVATE_FOLDERS.includes(subFolder)) {
    throw new Error('Le fichier n\'est pas un fichier privé');
  }
  return join(UPLOADS_ROOT, rel);
}

/**
 * Extrait le publicId d'une URL relative publique.
 *
 * '/uploads/AVATAR/x.jpg' → 'AVATAR/x.jpg'
 *
 * Ne reconnaît que les dossiers PUBLICS : retourne null pour tout autre URL
 * (dossier privé, dossier inconnu, URL absolue, chemin externe).
 */
export function publicIdFromUrl(url) {
  if (typeof url !== 'string') return null;
  const prefix = '/uploads/';
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  const subFolder = rest.slice(0, slash);
  if (!PUBLIC_KINDS.includes(subFolder)) return null;
  return rest;
}

/**
 * Supprime des fichiers devenus orphelins.
 *
 * Pour chaque publicId, le fichier n'est supprimé que si plus aucune ligne
 * Media ne le référence. Raison : une annonce copie les Media d'un lot avec
 * le même publicId — deux lignes peuvent référencer un même fichier.
 */
export async function deleteUnreferencedFiles(prismaClient, publicIds) {
  for (const publicId of publicIds) {
    const count = await prismaClient.media.count({ where: { publicId } });
    if (count === 0) {
      await deleteFile(publicId);
    }
  }
}
