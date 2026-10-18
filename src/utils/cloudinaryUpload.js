// Shim de rétrocompatibilité — Cloudinary → stockage local.
//
// Tous les contrôleurs importent `uploadBufferToCloudinary` depuis ce fichier.
// En re-exportant simplement `uploadFileLocally` sous ce nom, aucun contrôleur
// n'a besoin de changer son import. La logique réelle vit dans localUpload.js.
export { uploadFileLocally as uploadBufferToCloudinary } from './localUpload.js';

