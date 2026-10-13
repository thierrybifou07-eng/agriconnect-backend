import multer from 'multer';

// Doit correspondre exactement aux codes seedés dans MimeType (prisma/seed.js) :
// un mimetype accepté ici mais absent de la table ferait échouer l'upload plus loin.
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

// Stockage en mémoire (buffer) : le buffer est envoyé directement à Cloudinary
// via uploader.upload_stream, sans jamais écrire sur le disque du serveur.
// 8 Mo : un document d'identité (scan ou photo) dépasse rarement cette taille,
// et la limite protège la mémoire du processus.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      // statusCode 400 : un format refusé est une requête mal formée, pas une
      // erreur serveur (convention du projet, error.middleware.js).
      return cb(
        Object.assign(new Error('Format de fichier non supporté (jpg, png, webp, pdf)'), { statusCode: 400 })
      );
    }
    cb(null, true);
  },
});

export default upload;
