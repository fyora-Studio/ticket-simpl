'use strict';
// Brand integrity check: verifies the official attribution file has not been changed.
// This is an attribution safeguard, not cryptographic DRM; a person controlling the
// source code can alter any local check. Keep LICENSE.txt unchanged to pass the check.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const LICENSE_SHA256 = '1dadf4e29ed709ca3576570dd9a705f9e0162267f5d119547b20940bd2634581';
function verifyBrand() {
  const file = path.join(__dirname, '..', 'LICENSE.txt');
  if (!fs.existsSync(file)) throw new Error('Fyora Studio license file is missing.');
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (actual !== LICENSE_SHA256) throw new Error('Fyora Studio attribution check failed. Restore the original LICENSE.txt.');
}
module.exports = { verifyBrand };
