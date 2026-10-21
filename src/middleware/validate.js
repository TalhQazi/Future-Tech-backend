import { ZodError } from 'zod';
import { validationError } from '../lib/errors.js';

const formatIssues = (error) =>
  error.issues.map(i => ({ path: i.path.join('.'), message: i.message }));

// validate({ body, query, params }) — replaces each part with the parsed,
// stripped value so handlers only ever see validated input.
export const validate = (schemas) => (req, _res, next) => {
  try {
    if (schemas.params) req.params = schemas.params.parse(req.params);
    if (schemas.query) req.validatedQuery = schemas.query.parse(req.query);
    if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
    next();
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = formatIssues(err);
      return next(validationError(issues[0] ? `${issues[0].path || 'input'}: ${issues[0].message}` : 'Invalid input', issues));
    }
    next(err);
  }
};
