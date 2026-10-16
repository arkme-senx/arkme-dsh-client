// Initialize Electron's module hooks before loading the ESM client from ASAR.
// Catch early import failures so they are visible in the development run log.
const { app } = require('electron');
if (process.mas !== true) throw new Error('MAS_ELECTRON_REQUIRED');
import('./dist/main.js').catch(error => {
  console.error('MAS_BOOTSTRAP_FAILED', error.stack ?? error);
  app.exit(1);
});
