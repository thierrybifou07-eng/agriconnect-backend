// Conversion des schémas Joi 18 en JSON Schema (OpenAPI 3.0).
//
// Le paquet joi-to-json-schema vise l'API INTERNE de Joi 16/17 (isJoi, _type,
// _inner.children, _tests) : sous Joi 18 ces propriétés n'existent plus (type,
// $_terms.keys, $_rules) et la conversion échoue avec "requires a joi schema
// object". Ce module lit directement la structure de Joi 18 (dépendance déjà
// présente dans le projet pour la validation d'entrée).
//
// Prises en charge : string (minLength/maxLength/email/uri/pattern/alphanum/
// token/valid/allow(null)), number (integer/minimum/maximum/exclusive/precision/
// sign), boolean (valid), date (format date-time), object (required/forbidden/
// optional/minProperties), array (items/minItems/maxItems/uniqueItems),
// alternatives et .when() (rendus en anyOf + description).

function validsSet(schema) {
  // Joi 18 stocke les valeurs acceptées dans _valids._set (Set) ou _values.
  if (schema._valids && schema._valids._set instanceof Set) return schema._valids._set;
  if (schema._valids && schema._valids._values instanceof Set) return schema._valids._values;
  return null;
}

// Applique les règles (_rules) d'un schéma en respectant le type Joi : une
// contrainte min sur une chaîne est une longueur, sur un nombre un minimum,
// sur un tableau un nombre d'éléments, sur un objet un nombre de clés.
function applyRules(schema, kind) {
  const out = {};
  let nullable = false;
  const enumValues = [];

  for (const rule of schema._rules || []) {
    const args = rule.args || {};
    const limit = args.limit !== undefined ? args.limit : args;
    switch (rule.name) {
      case 'min':
        if (kind === 'string') out.minLength = limit;
        else if (kind === 'array') out.minItems = limit;
        else if (kind === 'object') out.minProperties = limit;
        else if (kind === 'number') out.minimum = limit;
        break;
      case 'max':
        if (kind === 'string') out.maxLength = limit;
        else if (kind === 'array') out.maxItems = limit;
        else if (kind === 'number') out.maximum = limit;
        break;
      case 'length':
        if (kind === 'string') { out.minLength = limit; out.maxLength = limit; }
        else if (kind === 'array') { out.minItems = limit; out.maxItems = limit; }
        break;
      case 'greater':
        // Sur une date la borne est un texte ('now', date ISO) : rien à traduire.
        if (kind === 'number' && typeof limit === 'number') {
          out.minimum = limit;
          out.exclusiveMinimum = true;
        }
        break;
      case 'less':
        if (kind === 'number' && typeof limit === 'number') {
          out.maximum = limit;
          out.exclusiveMaximum = true;
        }
        break;
      case 'precision':
        // precision(2) => multipleOf 0.01
        out.multipleOf = limit > 1 ? Number(`0.${'0'.repeat(limit - 1)}1`) : 1;
        break;
      case 'sign':
        // positive() / negative()
        out.minimum = 0;
        out.exclusiveMinimum = true;
        break;
      case 'integer':
        if (kind === 'number') out.type = 'integer';
        break;
      case 'alphanum': out.pattern = '^[a-zA-Z0-9]*$'; break;
      case 'token': out.pattern = '^[a-zA-Z0-9_]*$'; break;
      case 'email': out.format = 'email'; break;
      case 'uri': out.format = 'uri'; break;
      case 'iso': out.format = 'date-time'; break;
      case 'case': break; // uppercase/lowercase : pas de pattern JSON Schema fiable
      case 'pattern': {
        // Joi 18 : le motif est dans args.regex (RegExp) ; pas args.pattern.
        const src = args.regex instanceof RegExp ? args.regex : null;
        if (src) out.pattern = src.source;
        break;
      }
      case 'unique':
        if (kind === 'array') out.uniqueItems = true;
        break;
      default:
        // unknown, empty, trim, default... : sans équivalent JSON Schema.
        break;
    }
  }

  // valid([...]) / allow(...) : valeurs énumérées.
  const set = validsSet(schema);
  if (set) {
    for (const v of set) {
      if (v === null || v === undefined) nullable = true;
      else enumValues.push(v);
    }
  }
  // allow(null, '') : la chaîne vide est la valeur d'absence de Joi, pas une
  // contrainte — on ne la met pas dans l'enum.
  const meaningful = enumValues.filter((v) => v !== '');
  if (meaningful.length > 0) out.enum = meaningful;
  if (nullable || (enumValues.length > 0 && meaningful.length === 0)) out.nullable = true;

  return out;
}

// Description lisible d'un .when() Joi 18 : { ref, is, then, otherwise } où
// then/otherwise sont des modificateurs de présence (booléens) ou des schémas.
// Un schéma Joi.required() a type 'any' + presence 'required' : la présence
// prime sur le type dans la description.
function describeWhen(w) {
  const ref = w.ref && w.ref.key ? w.ref.key : '?';
  const isValids = w.is && w.is._valids ? [...(w.is._valids._values || w.is._valids._set || [])] : [];
  const target = isValids.length > 0 ? isValids.map(String).join('|') : '?';

  function branchDesc(branch) {
    if (!branch) return 'optionnel';
    if (branch === true) return 'requis';
    if (branch._flags && branch._flags.presence === 'required') return 'requis';
    if (branch._flags && branch._flags.presence === 'optional') return 'optionnel';
    if (branch._flags && branch._flags.presence === 'forbidden') return 'interdit';
    return `doit être ${branch.type || 'any'}`;
  }

  return { ref, target, thenDesc: branchDesc(w.then), otherwiseDesc: branchDesc(w.otherwise) };
}

function convert(schema) {
  if (!schema || typeof schema !== 'object' || !schema.type) return {};

  switch (schema.type) {
    case 'string': {
      return { type: 'string', ...applyRules(schema, 'string') };
    }

    case 'number': {
      // applyRules peut imposer type: 'integer' (règle integer()).
      return { type: 'number', ...applyRules(schema, 'number') };
    }

    case 'boolean': {
      return { type: 'boolean', ...applyRules(schema, 'boolean') };
    }

    case 'date': {
      return { type: 'string', format: 'date-time', ...applyRules(schema, 'date') };
    }

    case 'array': {
      const out = { type: 'array' };
      // $_terms.items : les schémas d'éléments (inclusions).
      const items = schema.$_terms && schema.$_terms.items;
      if (items && items.length > 0) out.items = convert(items[0]);
      Object.assign(out, applyRules(schema, 'array'));
      return out;
    }

    case 'object': {
      const out = { type: 'object', properties: {}, required: [] };
      const keys = (schema.$_terms && schema.$_terms.keys) || [];
      for (const key of keys) {
        const presence = key.schema._flags && key.schema._flags.presence;
        if (presence === 'forbidden') continue; // champ interdit : hors properties
        const prop = convert(key.schema);
        // Les .when() sur une clé gardent le type de base mais rendent la
        // présence ou le format conditionnels : la contrainte exacte vit dans
        // la description (JSON Schema ne l'exprime pas simplement).
        const whens = key.schema.$_terms && key.schema.$_terms.whens;
        if (whens && whens.length > 0 && !prop.description) {
          const parts = whens.map((w) => {
            const d = describeWhen(w);
            return `si ${d.ref} vaut ${d.target} : ${d.thenDesc}, sinon ${d.otherwiseDesc}`;
          });
          prop.description = `Conditionnel — ${parts.join(' ; ')}`;
        }
        out.properties[key.key] = prop;
        if (presence === 'required') out.required.push(key.key);
      }
      if (out.required.length === 0) delete out.required;
      const minRule = applyRules(schema, 'object');
      if (minRule.minProperties !== undefined) out.minProperties = minRule.minProperties;
      return out;
    }

    case 'alternatives': {
      // Joi.alternatives().try(...) : anyOf des branches.
      const matches = schema.$_terms && schema.$_terms.matches ? schema.$_terms.matches : [];
      const branches = matches.filter((m) => m.schema).map((m) => convert(m.schema));
      if (branches.length === 0) return {};
      if (branches.length === 1) return branches[0];
      return { anyOf: branches };
    }

    case 'any': {
      // Racine d'un .when(...) : anyOf des branches schémas + description des
      // conditions. Une branche 'forbidden' n'a pas d'équivalent JSON Schema :
      // elle n'est mentionnée que dans la description.
      const out = { ...applyRules(schema, 'any') };
      const whens = schema.$_terms && schema.$_terms.whens ? schema.$_terms.whens : [];
      const branches = [];
      const descs = [];
      for (const w of whens) {
        const d = describeWhen(w);
        descs.push(`si ${d.ref} vaut ${d.target} : ${d.thenDesc}, sinon ${d.otherwiseDesc}`);
        if (w.then && w.then.type) branches.push(convert(w.then));
        if (w.otherwise && w.otherwise.type && !(w.otherwise._flags && w.otherwise._flags.presence === 'forbidden')) {
          branches.push(convert(w.otherwise));
        }
      }
      if (branches.length === 1) Object.assign(out, branches[0]);
      else if (branches.length > 1) out.anyOf = branches;
      if (descs.length > 0) out.description = `Conditionnel — ${descs.join(' ; ')}`;
      return out;
    }

    default:
      return {};
  }
}

// Schéma JSON (OpenAPI) d'un schéma Joi, sans enveloppe de corps. Utile pour
// un corps optionnel : { required: false, content: { 'application/json': { schema: jsonSchema(x) } } }.
export function jsonSchema(joiSchema) {
  return convert(joiSchema);
}

// Schéma JSON d'un corps de requête JSON à partir d'un schéma Joi.
export function jsonBody(joiSchema) {
  return {
    required: true,
    content: { 'application/json': { schema: convert(joiSchema) } },
  };
}

// Schéma JSON d'un corps multipart (fichiers + champs texte). `file` décrit le
// champ fichier, `fields` les champs texte convertis depuis Joi.
export function multipartBody({ file, fields }) {
  const properties = {};
  const required = [];
  if (file) {
    properties[file.name] = {
      type: 'string',
      format: 'binary',
      description: file.description || 'Fichier',
    };
    required.push(file.name);
  }
  for (const [name, schema] of Object.entries(fields || {})) {
    properties[name] = convert(schema);
    if (schema._flags && schema._flags.presence === 'required') required.push(name);
  }
  return {
    required: true,
    content: {
      'multipart/form-data': {
        schema: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
      },
    },
  };
}
