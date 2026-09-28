// Preload (node --require) that makes the pg driver unresolvable, as if it were
// not installed, for both require() and import. Used to check that fixture and
// local mode never load it (#92).
const Module = require('node:module');

const blocked = (specifier) => specifier === 'pg' || specifier.startsWith('pg/');

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveWithoutPg(request, ...rest) {
  if (blocked(request)) throw Object.assign(new Error(`Cannot find module '${request}'`), { code: 'MODULE_NOT_FOUND' });
  return resolveFilename.call(this, request, ...rest);
};

Module.register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier === 'pg' || specifier.startsWith('pg/')) {
      throw Object.assign(new Error("Cannot find package 'pg'"), { code: 'ERR_MODULE_NOT_FOUND' });
    }
    return next(specifier, context);
  }
`)}`);
