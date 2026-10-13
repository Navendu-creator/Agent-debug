import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { config } from '../config.js';
import { intakeIncident } from './incidents.js';

test('intakeIncident sends the Teams ticket before resolving the request', async () => {
  const order: string[] = [];
  const server = http.createServer((_req, res) => {
    order.push('teams');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const prevWebhook = config.teamsWebhookUrl;
  const prevDryRun = config.dryRun;
  config.teamsWebhookUrl = `http://127.0.0.1:${port}`;
  config.dryRun = true;

  try {
    await intakeIncident({
      title: 'Teams-first smoke test',
      description: 'Verify the ticket is sent before the HTTP response resolves',
      severity: 'P2',
      source: 'web',
    });
    order.push('return');
    assert.ok(order.indexOf('teams') < order.indexOf('return'), 'Teams notification should happen before intake resolves');
  } finally {
    config.teamsWebhookUrl = prevWebhook;
    config.dryRun = prevDryRun;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
