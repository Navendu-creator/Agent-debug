import { config } from './config.js';
import { initDb, listIncidents } from './db.js';

// `npm run db:init` — creates the SQLite file and schema (the server also does this on startup).
initDb();
console.log(`Database ready at ${config.databaseUrl} (${listIncidents().length} incident(s))`);
