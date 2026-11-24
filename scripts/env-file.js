'use strict';

// Sets one KEY=value line in .env, keeping everything else (and the line endings) as it is.
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');

function setEnvValue(key, value) {
  const before = fs.readFileSync(envPath, 'utf8');
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  const after = pattern.test(before) ? before.replace(pattern, line) : `${before.replace(/\s*$/, '')}\n${line}\n`;
  if (after === before) return false;
  fs.writeFileSync(envPath, after);
  return true;
}

module.exports = { envPath, setEnvValue };
