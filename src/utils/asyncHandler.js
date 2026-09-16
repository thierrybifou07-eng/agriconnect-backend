// Evite de répéter try/catch dans chaque controller :
// les erreurs sont automatiquement transmises au errorHandler
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
