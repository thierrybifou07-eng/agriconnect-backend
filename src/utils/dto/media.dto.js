// DTO d'un media exposé au propriétaire : l'URL publique suffit pour
// afficher la photo ; publicId, fileSize, width, height et les clés
// de référence (mediaTypeId, mimeTypeId) sont internes et ne sortent pas.
export function mediaToApi(media) {
  return {
    id: media.id,
    url: media.url,
    isPrimary: media.isPrimary,
    position: media.position,
  };
}
