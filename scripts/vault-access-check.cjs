// Run by install-personal-mac.sh as a one-shot LaunchAgent: proves that node, started
// by launchd like the board server, can list the vault, read every board file and
// create a file there. Writes "ok", "missing: <board file>" or the first access error.
const fs = require('node:fs');
const path = require('node:path');

const [configPath, resultPath] = process.argv.slice(2);
let outcome = 'ok';
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  fs.readdirSync(config.vaultRoot);
  for (const board of config.boards) {
    if (board.archived) continue;
    const file = path.join(config.vaultRoot, board.file);
    try {
      fs.readFileSync(file);
    } catch (err) {
      if (err.code === 'ENOENT') throw Object.assign(new Error(file), { code: 'missing' });
      throw err;
    }
  }
  const probe = path.join(config.vaultRoot, `.obsidian-kanban-access-check-${process.pid}`);
  fs.writeFileSync(probe, 'probe\n', { flag: 'wx' });
  fs.unlinkSync(probe);
} catch (err) {
  outcome = err.code === 'missing' ? `missing: ${err.message}` : `${err.code ?? 'error'}: ${err.message}`;
}
fs.writeFileSync(resultPath, outcome);
