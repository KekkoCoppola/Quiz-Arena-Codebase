'use strict';

/**
 * server/license-public-key.js
 *
 * La chiave PUBBLICA con cui il Pi verifica le licenze. La scrive
 * `node tools/license-keygen.js` una volta sola, insieme alla chiave privata
 * che resta sul PC di chi vende. Pubblica significa che può stare nel repo e
 * sul Pi: serve solo a verificare, non a firmare.
 *
 * null finché le chiavi non sono state generate: con LICENSE_REQUIRED=1 e
 * nessuna chiave, ogni Pi resta in modalità demo (e il server lo dice all'avvio).
 */

module.exports = { PUBLIC_KEY: null };
