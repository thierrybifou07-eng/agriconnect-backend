import multer from 'multer';

// Doit correspondre exactement aux codes seedés dans MimeType (prisma/seed.js) :
// un mimetype accepté ici mais absent de la table ferait échouer l'upload plus loin.
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Stockage en mémoire (buffer) : le buffer est envoyé directement à Cloudinary
// via uploader.upload_stream, sans jamais écrire sur le disque du serveur.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo max par photo
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error("Format d'image non supporté (jpg, png, webp uniquement)"));
    }
    cb(null, true);
  },
});

export default upload;
