export const notFound = (req, res, next) => {
  res.status(404).json({ error: `Route non trouvée: ${req.originalUrl}` });
};

// Avec Express 5, les erreurs (sync ou async, y compris les rejets de Promise dans
// les controllers) remontent automatiquement ici sans wrapper try/catch manuel.
export const errorHandler = (err, req, res, next) => {
  // Journalisation volontairement limitée à l'erreur elle-même : les erreurs
  // métier ne portent que message + statusCode + code, et les erreurs de
  // validation Joi n'exposent que le champ et le message (validate.middleware.js).
  // Ni le corps de la requête (mots de passe inclus) ni les données personnelles
  // n'atteignent ce journal : aucun contrôleur n'attache req.body à une erreur.
  console.error(err);
  const status = err.statusCode || 500;
  const body = { error: err.message || 'Erreur serveur interne' };
  // Le code d'erreur (ex: INSUFFICIENT_STOCK) permet au client de distinguer les
  // echecs sans parser le message, qui reste destine a un affichage humain.
  if (typeof err.code === 'string') body.code = err.code;
  res.status(status).json(body);
};
