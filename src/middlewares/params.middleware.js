// Express fournit toujours les parametres de route sous forme de chaine : meme
// l'URL /api/listings/1 donne req.params.id === "1".
//
// Or toutes les cles primaires du schema sont des Int (id Int @id @default
// (autoincrement())). Passer la chaine telle quelle a Prisma leve une
// PrismaClientValidationError, et chaque route paramtree repondait 500 :
// GET /api/listings/:id, PATCH /api/listings/:id, DELETE /api/listings/:id,
// GET /api/orders/:id, PATCH /api/orders/:id/confirm, /cancel, /complete,
// GET et POST /api/conversations/:id/messages, POST /api/deliveries/:id/accept,
// PATCH /api/deliveries/:id/status, et les quatre routes /api/admin/*/:id.
//
// Ce gestionnaire s'installe via router.param('id', ...) et non router.use() :
// un middleware de routeur s'execute sur une couche sans parametres, et la
// couche qui matche ensuite ecrase req.params, annulant la conversion. Le
// crochet param s'execute une fois le parametre extrait, donc la valeur
// convertie tient jusqu'au controleur.
//
// `:id` est le seul parametre de route du projet. Un identifiant non numerique
// est rejete en 400 plutot que de laisser Prisma lever une erreur serveur.

const ENTIER = /^[0-9]+$/;

export function coerceIdParam(req, res, next, value) {
  if (!ENTIER.test(value)) {
    return res.status(400).json({ error: 'Identifiant invalide' });
  }
  req.params.id = Number(value);
  next();
}