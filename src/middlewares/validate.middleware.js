// Middleware générique de validation Joi. Utilise validateAsync pour supporter
// à la fois les règles synchrones et les règles .external() asynchrones
// (ex: vérifier qu'une catégorie existe bien en base avant de créer une annonce).
export const validate = (schema, property = 'body') => async (req, res, next) => {
  try {
    const value = await schema.validateAsync(req[property], { abortEarly: false, stripUnknown: true });
    if (property === 'query') {
      // Express 5 définit req.query par defineGetter (request.js) : un
      // accesseur sans setter. L'affectation req.query = value lèverait en
      // mode strict (ESM). On redéfinit la propriété sur l'instance, avec
      // les attributs d'une propriété de données : le getter d'origine est
      // masqué pour le reste du traitement de la requête.
      Object.defineProperty(req, 'query', { value, writable: true, configurable: true, enumerable: true });
    } else {
      req[property] = value;
    }
    next();
  } catch (error) {
    if (error.isJoi) {
      return res.status(400).json({
        error: 'Données invalides',
        details: error.details.map((d) => ({ field: d.path.join('.'), message: d.message })),
      });
    }
    next(error);
  }
};
