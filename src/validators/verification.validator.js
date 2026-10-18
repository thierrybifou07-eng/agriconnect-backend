import Joi from 'joi';

// POST /api/v2/auth/me/documents — type de document déposé (enum DocumentType).
export const submitDocumentSchema = Joi.object({
  type: Joi.string().valid('ID_CARD', 'BUSINESS_REGISTRATION', 'FARM_PROOF', 'OTHER').required(),
});

// GET /api/v2/admin/verifications — filtres de la file de revue.
//
// La requête est validée en amont (validate(schema, 'query')) : la pagination
// était auparavant bornée par le contrôleur, donc un `limit=0` ou `limit=10000`
// passait ; un `?limit=abc` devenait NaN. Les valeurs sont donc contrôlées ici,
// et les defauts (page 1, limit 20) sont portés par le schema.
export const listVerificationsQuerySchema = Joi.object({
  // Statut du DOCUMENT examiné, pas celui du compte (ce dernier se lit dans
  // user.profileVerificationStatus, renvoyé par la liste).
  status: Joi.string().valid('PENDING', 'VERIFIED', 'REJECTED'),
  type: Joi.string().valid('ID_CARD', 'BUSINESS_REGISTRATION', 'FARM_PROOF', 'OTHER'),
  role: Joi.string().valid('SUPPLIER', 'BUYER'),
  // Seuls SUPPLIER et BUYER déposent des documents : les autres rôles n'ont
  // rien à faire dans cette file.
  userId: Joi.number().integer().positive(),
  page: Joi.number().integer().min(1).default(1),
  // Plafond de 100 : une liste de dossiers n'a pas à sortir 10 000 documents
  // d'un coup.
  limit: Joi.number().integer().min(1).max(100).default(20),
});

// PATCH /api/v2/admin/verifications/:id — décision d'examen. La note est
// obligatoire en cas de rejet : rejeter sans dire pourquoi priverait
// l'utilisateur de toute correction possible.
export const reviewVerificationSchema = Joi.object({
  decision: Joi.string().valid('APPROVE', 'REJECT').required(),
  note: Joi.when('decision', {
    is: 'REJECT',
    then: Joi.string().trim().min(1).max(2000).required(),
    otherwise: Joi.string().trim().max(2000).allow(null).empty(''),
  }),
});
