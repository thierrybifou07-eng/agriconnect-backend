// config/openapi/openapi.helpers.js
//
// Fabrication du document OpenAPI : conversion des schémas Joi de
// src/validators en JSON Schema, et fabriques de réponses / paramètres.
//
// Ces deux axes sont distincts : le premier évite de dupliquer à la main les
// règles des validateurs (une source de vérité), le second évite de répéter à
// la main le format des réponses, qui est imposé par middlewares/error.
// middleware.js et par les DTO de src/utils/dto.

import joiToJsonSchema from 'joi-to-json-schema';

// ---------------------------------------------------------------------------
// 1. Joi -> JSON Schema
// ---------------------------------------------------------------------------

// joi-to-json-schema lit l'API interne de Joi 16/17 (isJoi, _inner, _tests) qui
// n'existe plus en Joi 18 : le projet est passé en Joi 18 (voir lot.validator.js,
// qui commente explicitement un changement de cette version), et la bibliothèque
// lève alors « requires a joi schema object ». La bibliothèque est
// donc tentée en premier — elle redeviendrait le chemin naturel si le projet
// repassait en Joi 17 — et le convertisseur ci-dessous prend le relais en
// lisant la structure de Joi 18 : _flags (presence, only, default), _rules
// (min, max, pattern, sign...), _valids._values (Set des valeurs acceptées),
// $_terms (keys, items, matches, whens).
export function toJsonSchema(joiSchema, { description } = {}) {
  if (!joiSchema || typeof joiSchema !== 'object') return {};
  try {
    return withDescription(joiToJsonSchema(joiSchema), description);
  } catch {
    return withDescription(convertJoi18(joiSchema), description);
  }
}

function withDescription(schema, description) {
  return description ? { ...schema, description } : schema;
}

// Une valeur Joi::any / forbidden ne se décrit pas : un champ absent du corps
// est le comportement réel de l'API, on ne publie donc aucun schéma.
function isEmptySchema(schema) {
  return !schema || Object.keys(schema).length === 0;
}

function convertJoi18(joi) {
  if (!joi || typeof joi !== 'object' || !joi.type) return {};

  const flags = joi._flags || {};
  const terms = joi.$_terms || {};
  const rules = joi._rules || [];
  const notes = [];
  const out = {};

  // Alternatives : chaque branche devient un membre de oneOf.
  if (terms.matches && terms.matches.length > 0) {
    const branches = terms.matches.map(convertJoi18).filter((s) => !isEmptySchema(s));
    if (branches.length === 0) return {};
    if (branches.length === 1) return branches[0];
    return { oneOf: branches };
  }

  switch (joi.type) {
    case 'string':
      out.type = 'string';
      break;
    case 'number':
      out.type = 'number';
      break;
    case 'boolean':
      out.type = 'boolean';
      break;
    case 'date':
      out.type = 'string';
      out.format = 'date-time';
      break;
    case 'array':
      out.type = 'array';
      break;
    case 'object':
      out.type = 'object';
      break;
    case 'binary':
      out.type = 'string';
      out.format = 'binary';
      break;
    default:
      // any : pas de type imposé. Seuls les formats (.uri() sans string()) se
      // traduisent encore.
      break;
  }

  // Règles de forme et de bornes.
  for (const rule of rules) {
    const args = rule.args || {};
    const limit = args.limit;
    switch (rule.name) {
      case 'min':
        if (out.type === 'string') out.minLength = limit;
        else if (out.type === 'array') out.minItems = limit;
        else if (out.type === 'object') out.minProperties = limit;
        else if (out.type === 'number' || out.type === 'integer') out.minimum = limit;
        break;
      case 'max':
        if (out.type === 'string') out.maxLength = limit;
        else if (out.type === 'array') out.maxItems = limit;
        else if (out.type === 'number' || out.type === 'integer') out.maximum = limit;
        break;
      case 'length':
        if (out.type === 'string') {
          out.minLength = limit;
          out.maxLength = limit;
        } else if (out.type === 'array') {
          out.minItems = limit;
          out.maxItems = limit;
        }
        break;
      case 'integer':
        out.type = 'integer';
        break;
      case 'sign':
        // .positive() / .negative() : bornes strictes, pas des bornes incluses.
        if (args.sign === 'positive') {
          out.minimum = 0;
          out.exclusiveMinimum = true;
        } else if (args.sign === 'negative') {
          out.maximum = 0;
          out.exclusiveMaximum = true;
        }
        break;
      case 'greater':
        if (out.type === 'number' || out.type === 'integer') {
          out.minimum = limit;
          out.exclusiveMinimum = true;
        } else if (joi.type === 'date') {
          notes.push('doit être une date future');
        }
        break;
      case 'less':
        if (out.type === 'number' || out.type === 'integer') {
          out.maximum = limit;
          out.exclusiveMaximum = true;
        }
        break;
      case 'multiple':
        out.multipleOf = limit;
        break;
      case 'precision':
        // .precision(n) : n décimales au plus, donc un pas de 10^-n.
        if (typeof limit === 'number' && limit > 0) {
          out.multipleOf = Number((1 / 10 ** limit).toFixed(limit));
        }
        break;
      case 'email':
        out.format = 'email';
        break;
      case 'uri':
        out.format = 'uri';
        break;
      case 'isoDate':
        out.format = 'date-time';
        break;
      case 'guid':
        out.format = 'uuid';
        break;
      case 'pattern':
        if (args.regex instanceof RegExp) out.pattern = args.regex.source;
        break;
      case 'alphanum':
        out.pattern = '^[a-zA-Z0-9]*$';
        break;
      case 'token':
        out.pattern = '^[a-zA-Z0-9_]*$';
        break;
      case 'unique':
        out.uniqueItems = true;
        break;
      case 'lowercase':
        notes.push('en minuscules');
        break;
      case 'uppercase':
        notes.push('en majuscules');
        break;
      case 'items':
      case 'custom':
      case 'trim':
      case 'default':
      case 'empty':
      case 'case':
      default:
        // Sans traduction en JSON Schema : .custom() porte une règle métier
        // (précision décimale) décrite dans le commentaire du validateur,
        // .trim() ne change rien au type.
        break;
    }
  }

  // Valeurs acceptées : .valid() énumère, .allow(null) rend le champ nullable.
  // En OpenAPI 3.0, null ne peut pas figurer dans un enum : il se dit
  // nullable, et sort donc de la liste.
  const accepted = joi._valids && joi._valids._values;
  if (accepted instanceof Set && accepted.size > 0 && out.type) {
    const values = [...accepted];
    const nullable = values.some((v) => v === null);
    // allow(null, '') : la chaîne vide est la valeur d'absence de Joi, pas une
    // contrainte — elle ne doit donc pas apparaître dans l'énumération.
    const meaningful = values.filter((v) => v !== null && v !== '');
    if (flags.only) {
      if (meaningful.length > 0) out.enum = meaningful;
      if (nullable || meaningful.length === 0) out.nullable = true;
    } else if (nullable) {
      out.nullable = true;
    }
  }

  if ('default' in flags) out.default = flags.default;

  // Tableau : le schéma des éléments.
  if (joi.type === 'array' && terms.items && terms.items.length > 0) {
    const itemSchema = convertJoi18(terms.items[0]);
    if (!isEmptySchema(itemSchema)) out.items = itemSchema;
  }

  // Objet : les propriétés, et la liste des champs obligatoires.
  if (joi.type === 'object' && terms.keys && terms.keys.length > 0) {
    out.properties = {};
    const required = [];
    for (const entry of terms.keys) {
      const property = convertJoi18(entry.schema);
      if (isEmptySchema(property)) continue; // Joi.forbidden() : jamais envoyé
      out.properties[entry.key] = property;
      if (entry.schema._flags && entry.schema._flags.presence === 'required') {
        required.push(entry.key);
      }
    }
    if (required.length > 0) out.required = required;
  }

  // Conditions .when() : le champ n'a pas toujours la même forme, selon la
  // valeur d'un champ voisin. JSON Schema ne sait pas lire un champ voisin :
  // la condition est donc écrite en clair dans la description, et seule une
  // branche qui décrit un OBJET est publiée en allOf — c'est le seul cas où
  // elle apporte une forme structurante. Pour un scalaire, l'ajouter en
  // branche rendrait le schéma faux (une contrainte valable dans un seul cas
  // deviendrait obligatoire partout).
  if (terms.whens && terms.whens.length > 0) {
    const shapes = [];
    for (const when of terms.whens) {
      notes.push(describeWhen(when));
      for (const branch of [when.then, when.otherwise]) {
        if (!branch || branch === true || branch === false) continue;
        const converted = convertJoi18(branch);
        if (converted.type === 'object' && converted.properties) shapes.push(converted);
      }
    }
    if (shapes.length > 0) {
      if (!out.type) {
        // Joi.when() sans branche propre est de type any : la forme utile du
        // champ est celle de la branche qui s'applique.
        Object.assign(out, shapes[0]);
        if (shapes.length > 1) out.allOf = shapes.slice(1);
      } else {
        out.allOf = shapes;
      }
    } else if (!out.type) {
      // Aucun objet parmi les branches : on récupère au moins le type, sans
      // ses bornes — une borne valable dans un seul cas deviendrait, écrite
      // seule, une contrainte applicable partout.
      for (const when of terms.whens) {
        for (const branch of [when.then, when.otherwise]) {
          if (!branch || branch === true || branch === false) continue;
          const converted = convertJoi18(branch);
          if (converted.type) {
            out.type = converted.type;
            if (converted.format) out.format = converted.format;
            break;
          }
        }
        if (out.type) break;
      }
    }
  }

  if (notes.length > 0) out.description = notes.join(' ; ');
  return out;
}

// Traduction en clair d'une condition .when(), pour que la contrainte soit
// lisible dans l'interface sans avoir à ouvrir le validateur. Les branches d'un
// .when() sont des schémas Joi, pas des booléens : leur présence se lit sur
// _flags.presence.
function describeWhen(when) {
  const ref = (when.ref && when.ref.key) || 'un champ';
  const accepted = when.is && when.is._valids && when.is._valids._values;
  const values = accepted instanceof Set ? [...accepted].filter((v) => v !== null) : [];
  const cible = values.length > 0 ? values.join(' / ') : 'une valeur donnée';
  const presence = (branch) => {
    if (branch === true) return 'required';
    if (branch === false) return 'forbidden';
    return (branch && branch._flags && branch._flags.presence) || null;
  };
  const thenPresence = presence(when.then);
  const otherwisePresence = presence(when.otherwise);
  if (thenPresence === 'required') return `obligatoire quand ${ref} vaut ${cible}`;
  if (thenPresence === 'forbidden') return `interdit quand ${ref} vaut ${cible}`;
  if (otherwisePresence === 'required') return `obligatoire sauf si ${ref} vaut ${cible}`;
  if (otherwisePresence === 'forbidden') return `interdit sauf si ${ref} vaut ${cible}`;
  return `dont la valeur dépend de ${ref} (${cible})`;
}

// ---------------------------------------------------------------------------
// 2. Réponses
// ---------------------------------------------------------------------------

// Forme d'erreur unique du projet : middlewares/error.middleware.js répond
// { error, code? }. `code` est le code métier stable (INSUFFICIENT_STOCK,
// INVALID_STATE_TRANSITION...) : le message reste destiné à l'affichage, le
// code au branchement côté client.
export const ErrorSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: { type: 'string', description: "Message d'erreur destiné à l'affichage" },
    code: {
      type: 'string',
      nullable: true,
      description: 'Code métier stable, absent pour une erreur sans code',
    },
  },
};

// 400 du middleware de validation Joi : le détail champ par champ est ce qui
// permet au client de surligner le bon input.
export const ValidationErrorSchema = {
  type: 'object',
  required: ['error', 'details'],
  properties: {
    error: { type: 'string', example: 'Données invalides' },
    details: {
      type: 'array',
      items: {
        type: 'object',
        required: ['field', 'message'],
        properties: {
          field: { type: 'string', description: 'Champ fautif (chemin pointé pour un objet imbriqué)' },
          message: { type: 'string' },
        },
      },
    },
  },
};

/**
 * Réponse JSON de succès. L'API ne pose pas d'enveloppe { status, message, data } :
 * les contrôleurs renvoient l'entité, ou une liste, directement.
 */
export const makeSuccessResponse = (schema, { description, example } = {}) => ({
  'application/json': {
    schema: withDescription(schema, description),
    ...(example ? { example } : {}),
  },
});

/** Réponse d'erreur { error, code? }. */
export const makeErrorResponse = (messageExample, codeExample) => ({
  'application/json': {
    schema: ErrorSchema,
    ...(messageExample ? { example: { error: messageExample, ...(codeExample ? { code: codeExample } : {}) } } : {}),
  },
});

/** 400 du validateur Joi, avec le détail par champ. */
export const makeValidationErrorResponse = () => ({
  'application/json': {
    schema: ValidationErrorSchema,
    example: {
      error: 'Données invalides',
      details: [{ field: 'email', message: 'Email must be a valid email address' }],
    },
  },
});

/**
 * Liste paginée : le wrapper { items, page, limit, total } est la convention du
 * projet (page par défaut 1, limit par défaut 20, plafond 100).
 */
export const makePaginatedResponse = (itemSchema, description) => ({
  'application/json': {
    schema: {
      type: 'object',
      required: ['items', 'page', 'limit', 'total'],
      properties: {
        items: { type: 'array', items: itemSchema },
        page: { type: 'integer', example: 1 },
        limit: { type: 'integer', example: 20 },
        total: { type: 'integer', description: 'Nombre total de lignes, toutes pages confondues' },
      },
    },
    ...(description ? { description } : {}),
  },
});

// ---------------------------------------------------------------------------
// 3. Corps de requête
// ---------------------------------------------------------------------------

/** Corps JSON dont le schéma est écrit à la main (réponses agrégées). */
export const makeJsonRequestBody = (schema, { required = true, description, example } = {}) => ({
  required,
  description,
  content: {
    'application/json': {
      schema,
      ...(example ? { example } : {}),
    },
  },
});

/** Corps JSON dérivé du validateur Joi réellement utilisé par la route. */
export const makeJoiRequestBody = (joiSchema, { required = true, description } = {}) =>
  makeJsonRequestBody(toJsonSchema(joiSchema), { required, description });

/**
 * Corps multipart : les champs texte sont décrits par leur schéma Joi (il en
 * existe bien un, la validation passe après multer), les fichiers par leur type
 * réel accepté par upload.middleware.js.
 */
export const makeMultipartRequestBody = ({
  fields = {},
  files = {},
  required = true,
  description,
} = {}) => {
  const properties = {};
  for (const [name, schema] of Object.entries(fields)) properties[name] = schema;
  for (const [name, file] of Object.entries(files)) {
    properties[name] = {
      type: 'string',
      format: 'binary',
      description: file.description || 'Fichier envoyé',
    };
  }
  const schema = { type: 'object', properties };
  if (required) {
    schema.required = [...Object.keys(fields), ...Object.keys(files)];
  }
  return { required, description, content: { 'multipart/form-data': { schema } } };
};

// ---------------------------------------------------------------------------
// 4. Paramètres
// ---------------------------------------------------------------------------

/**
 * Paramètre de chemin. Les identifiants sont des entiers : coerceIdParam
 * (params.middleware.js) convertit la chaîne et répond 400 si ce n'en est pas
 * un, plutôt que de laisser Prisma échouer.
 */
export const makePathParam = (name, description, schema = { type: 'integer' }) => ({
  name,
  in: 'path',
  required: true,
  description,
  schema,
});

export const makeQueryParam = (name, description, schema, { required = false, example } = {}) => ({
  name,
  in: 'query',
  required,
  description,
  schema,
  ...(example !== undefined ? { example } : {}),
});

export const makeHeaderParam = (name, description, schema, { required = false, example } = {}) => ({
  name,
  in: 'header',
  required,
  description,
  schema,
  ...(example !== undefined ? { example } : {}),
});

/** Pagination : les deux paramètres acceptés par tous les endpoints paginés. */
export const paginationParams = () => [
  makeQueryParam('page', 'Numéro de page (1 par défaut)', { type: 'integer', minimum: 1, default: 1 }),
  makeQueryParam(
    'limit',
    'Nombre de lignes par page (20 par défaut, 100 au maximum)',
    { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  ),
];

// ---------------------------------------------------------------------------
// 5. Briques de schéma réutilisées par les fragments
// ---------------------------------------------------------------------------

export const dateTimeSchema = { type: 'string', format: 'date-time' };
export const nullableDateTimeSchema = { type: 'string', format: 'date-time', nullable: true };
export const nullableStringSchema = { type: 'string', nullable: true };
export const nullableNumberSchema = { type: 'number', nullable: true };
export const nullableIntegerSchema = { type: 'integer', nullable: true };

/** Référence { code, label } : convention userApi.js et category.dto.js. */
export const referenceSchema = (example) => ({
  type: 'object',
  properties: { code: { type: 'string', example }, label: { type: 'string', example } },
});

/** Montant : nombre JSON, jamais une chaîne (decimal-json.middleware.js). */
export const moneySchema = (example = 5000) => ({ type: 'number', example });