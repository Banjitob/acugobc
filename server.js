// Render's dashboard runs `node server.js` from the repo root, but the real
// app lives in backend/. This just forwards to it.
//
// Deliberately NOT loading dotenv here: `dotenv` is a backend-only dependency
// (backend/node_modules), so requiring it from the root has no node_modules
// to resolve against and crashes with MODULE_NOT_FOUND. backend/server.js
// already calls dotenv.config() itself, which is enough for local dev — and
// on Render, env vars are injected directly into process.env regardless.
require('./backend/server');
