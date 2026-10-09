import cloudinary from '../config/cloudinary.js';

// Upload un buffer en mémoire vers Cloudinary (multer.memoryStorage() ne passe pas
// par le disque - upload_stream est la façon officielle de gérer ce cas).
//
// Deux modes, sans casser les appelants existants :
//  - sans options (ou type !== 'authenticated') : comportement historique —
//    dossier listings, transformation, et l'URL publique seule en chaîne
//    (uploadAvatar n'a pas besoin de connaître le public_id) ;
//  - avec { folder, type: 'authenticated' } : envoi privé (document de vérification)
//    et retour { url, public_id } — le public_id sert à générer l'URL signée de
//    courte durée côté staff (GET /api/v2/admin/verifications/:id).
export function uploadBufferToCloudinary(buffer, options = {}) {
  const isPrivate = options.type === 'authenticated';
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      isPrivate
        ? { folder: options.folder, type: 'authenticated' }
        : {
            folder: 'agriconnect/listings',
            transformation: [{ width: 1200, height: 1200, crop: 'limit' }],
          },
      (error, result) => {
        if (error) return reject(error);
        // En mode privé, le public_id est renvoyé lui aussi : c'est la clé qui
        // permet au staff de générer une URL signée sans exposer le fichier.
        if (isPrivate) return resolve({ url: result.secure_url, public_id: result.public_id });
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}
