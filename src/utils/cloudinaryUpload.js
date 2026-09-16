import cloudinary from '../config/cloudinary.js';

// Upload un buffer en mémoire vers Cloudinary (multer.memoryStorage() ne passe pas
// par le disque - upload_stream est la façon officielle de gérer ce cas).
export function uploadBufferToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'agriconnect/listings',
        transformation: [{ width: 1200, height: 1200, crop: 'limit' }],
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}
