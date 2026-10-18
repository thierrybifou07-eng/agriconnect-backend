// Contrôle du contenu réel d'un fichier.
//
// Le type MIME d'un envoi multipart vient de l'en-tête `Content-Type` que le
// client déclare : il se contrôle aussi facilement qu'un nom de fichier. Un
// fichier texte renommé `piece.png` passe le filtre du middleware, puis se
// retrouve stocké, servi et affiché comme une image. On compare donc les
// octets de tête du buffer au type déclaré — c'est le seul contrôle qui
// porte sur le contenu lui-même.
//
// Les signatures sont les « magic numbers » des quatre formats acceptés par
// les middlewares d'upload (JPEG, PNG, WEBP, PDF). Comparer quelques octets
// ne demande aucune dépendance : pas de lecture d'image, pas de bibliographic.

/** Convertit une chaîne ASCII en tableau d'octets. */
const ascii = (texte) => Array.from(texte, (caractere) => caractere.charCodeAt(0));

// Signature attendue par type MIME. Une entrée est une liste de segments :
// certains formats (WEBP) ne sont pas identifiables par leurs premiers
// octets seuls, leur marque est suivie d'une taille puis d'un second marqueur.
const SIGNATURES = {
  // FF D8 FF : début de marqueur d'image JPEG (le troisième octet FF ouvre
  // l'application, pas de type de marqueur unique).
  'image/jpeg': [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  // 89 50 4E 47 0D 0A 1A 0A : les huit octets de signature PNG, uniques.
  'image/png': [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  // "RIFF" .... "WEBP" : RIFF ouvre le conteneur, la marque du format est
  // repartie apres les quatre octets de taille du chunk.
  'image/webp': [
    { offset: 0, bytes: ascii('RIFF') },
    { offset: 8, bytes: ascii('WEBP') },
  ],
  // %PDF- : les cinq premiers octets de tout document PDF.
  'application/pdf': [{ offset: 0, bytes: ascii('%PDF-') }],
};

function correspondSegment(buffer, offset, attendu) {
  if (buffer.length < offset + attendu.length) return false;
  return attendu.every((octet, index) => buffer[offset + index] === octet);
}

function erreurContenu(mimetype) {
  // statusCode + code : la convention des middlewares d'upload. Le middleware
  // d'erreur les renvoie tels quels, sans qu'un contrôleur ait à traduire.
  return Object.assign(
    new Error(`Le contenu du fichier ne correspond pas au type déclaré (${mimetype})`),
    { statusCode: 400, code: 'FILE_CONTENT_MISMATCH' }
  );
}

/**
 * Vérifie que le buffer correspond bien au type MIME déclaré.
 *
 * @param {Buffer} buffer   contenu du fichier, tel que reçu par multer.
 * @param {string} mimetype type MIME déclaré par le client.
 * @throws {Error} 400 / code FILE_CONTENT_MISMATCH si les octets de tête ne
 *                   correspondent pas, si le buffer est trop court, ou si le
 *                   type n'a aucune signature connue (donc rien à vérifier).
 */
export function assertFileSignature(buffer, mimetype) {
  const signature = SIGNATURES[mimetype];
  // Type sans signature connue : on ne peut pas affirmer que le contenu est
  // celui qu'il déclare. Accepter serait laisser un angle mort ; refuser est
  // la seule position sûre tant que le format n'est pas connu ici.
  if (!signature) throw erreurContenu(mimetype);

  if (!Buffer.isBuffer(buffer)) throw erreurContenu(mimetype);

  const conforme = signature.every((segment) =>
    correspondSegment(buffer, segment.offset, segment.bytes)
  );
  if (!conforme) throw erreurContenu(mimetype);
}