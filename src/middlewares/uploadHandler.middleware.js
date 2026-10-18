import { MulterError } from 'multer';

// Autres erreurs multer qui signalent une requête multipart mal formée :
// elles répondent en 400 INVALID_MULTIPART, comme LIMIT_UNEXPECTED_FILE.
const INVALID_MULTIPART_CODES = new Set([
  'LIMIT_FILE_COUNT',
  'LIMIT_PART_COUNT',
  'LIMIT_FIELD_KEY',
  'LIMIT_FIELD_VALUE',
  'LIMIT_FIELD_COUNT',
]);

// Wrapper commun à toutes les routes multer (avatar, documents, photos de
// lots et d'annonces). Sans lui, une MulterError remonte au middleware
// d'erreur global, qui ne voit pas de statusCode et répond 500 : un client
// qui se trompe de champ fichier ou envoie un sixième fichier obtiendrait
// une erreur serveur. Ici chaque cas métier a un statut et un code propres.
export const handleUpload = (multerMiddleware, { field, maxFiles = 1, maxSizeMb }) => (req, res, next) => {
  multerMiddleware(req, res, (err) => {
    if (!err) return next();

    // Erreur du fileFilter (format refusé) : statusCode 400 et porte un code
    // (UNSUPPORTED_MEDIA_TYPE, voir upload.middleware.js et
    // uploadDocument.middleware.js). On renvoie son message et son code.
    if (err.statusCode === 400) {
      const body = { error: err.message };
      if (typeof err.code === 'string') body.code = err.code;
      return res.status(400).json(body);
    }

    if (err instanceof MulterError) {
      switch (err.code) {
        // Un fichier dans un champ inattendu, ou au-delà de maxFiles : le
        // message nomme explicitement le champ attendu, et expectedField le
        // reprend pour un usage programmatique.
        case 'LIMIT_UNEXPECTED_FILE': {
          const message =
            maxFiles === 1
              ? `Champ fichier inattendu "${err.field}". Envoyez un seul fichier dans le champ "${field}".`
              : `Champ fichier inattendu "${err.field}" ou trop de fichiers (maximum ${maxFiles}) dans le champ "${field}".`;
          return res.status(400).json({ error: message, code: 'UNEXPECTED_FILE_FIELD', expectedField: field });
        }
        case 'LIMIT_FILE_SIZE':
          return res.status(413).json({
            error: `Fichier trop volumineux dans le champ "${field}" : maximum ${maxSizeMb} Mo.`,
            code: 'FILE_TOO_LARGE',
          });
        default:
          if (INVALID_MULTIPART_CODES.has(err.code)) {
            return res.status(400).json({ error: 'Requête multipart mal formée', code: 'INVALID_MULTIPART' });
          }
          break;
      }
    }

    // Toute autre erreur n'est pas un cas multipart connu : elle remonte au
    // middleware d'erreur global (error.middleware.js), comme avant.
    next(err);
  });
};

export default handleUpload;
