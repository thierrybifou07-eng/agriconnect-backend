const multer = require('multer');

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

// Stockage en mémoire (buffer) : on envoie ensuite le buffer directement à Cloudinary
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

module.exports = upload;
