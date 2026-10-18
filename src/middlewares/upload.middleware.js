import multer from 'multer';

// Doit correspondre exactement aux codes seedés dans MimeType (prisma/seed.js) :
// un mimetype accepté ici mais absent de la table ferait échouer l'upload plus loin.
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Stockage en mémoire (buffer) : le buffer est écrit sur disque par
// services/storage.service.js, jamais par multer lui-même.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo max par photo
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      // Meme convention que uploadDocument.middleware.js : statusCode 400 et
      // code stable, afin que handleUpload puisse les renvoyer tels quels.
      return cb(
        Object.assign(new Error("Format d'image non supporté (jpg, png, webp uniquement)"), {
          statusCode: 400,
          code: 'UNSUPPORTED_MEDIA_TYPE',
        })
      );
    }
    cb(null, true);
  },
});

export default upload;
