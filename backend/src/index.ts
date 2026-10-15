import { createApp } from './app.js';
import { config, startupWarnings } from './config.js';
import { initDb, recoverInterrupted } from './db.js';

initDb();
const recovered = recoverInterrupted();

createApp().listen(config.port, config.host, () => {
  console.log(`Nagent API listening on http://${config.host}:${config.port}`);
  console.log(
    `Database: ${config.databaseUrl} · AI: Ollama ${config.ollamaModel} @ ${config.ollamaBaseUrl} · ` +
      `${config.ollamaNumThread ?? "Ollama's default"} CPU threads · timeout ${Math.round(config.aiTimeoutMs / 60_000)} min`,
  );
  if (recovered) console.log(`Marked ${recovered} interrupted incident(s) for retry`);
  for (const w of startupWarnings()) console.warn(`⚠ ${w}`);
});
