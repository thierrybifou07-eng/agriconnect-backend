export const notFound = (req, res, next) => {
  res.status(404).json({ error: `Route non trouvée: ${req.originalUrl}` });
};

// Avec Express 5, les erreurs (sync ou async, y compris les rejets de Promise dans
// les controllers) remontent automatiquement ici sans wrapper try/catch manuel.
export const errorHandler = (err, req, res, next) => {
  console.error(err);
  const status = err.statusCode || 500;
  res.status(status).json({
    error: err.message || 'Erreur serveur interne',
  });
};
