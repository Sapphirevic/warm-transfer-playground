'use strict';

// Usage: npm run call -- +15551234567
// Asks the local server to ring the person playing the resident.
require('dotenv').config({ quiet: true });

const to = process.argv[2];
if (!to) {
  console.error('Usage: npm run call -- +15551234567');
  process.exit(1);
}

const port = Number(process.env.PORT) || 3000;

fetch(`http://localhost:${port}/start-call`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Tool-Secret': process.env.TOOL_SECRET || '' },
  body: JSON.stringify({ to }),
})
  .then(async (response) => {
    console.log(response.status, await response.text());
    if (!response.ok) process.exitCode = 1;
  })
  .catch((err) => {
    console.error(`Could not reach the server on port ${port} (is "npm start" running?): ${err.message}`);
    process.exitCode = 1;
  });
