const notFound = (req, res, next) => {
  res.status(404).json({ error: `Route non trouvée: ${req.originalUrl}` });
};

const errorHandler = (err, req, res, next) => {
  console.error(err);
  const status = err.statusCode || 500;
  res.status(status).json({
    error: err.message || 'Erreur serveur interne',
  });
};

module.exports = { notFound, errorHandler };
