// Run by install-personal-mac.sh as a one-shot LaunchAgent: proves that node, started
// by launchd like the board server, can list the vault, read every board file and
// create a file there. Writes "ok" or the first error to the result file.
const fs = require('node:fs');
const path = require('node:path');

const [configPath, resultPath] = process.argv.slice(2);
let outcome = 'ok';
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  fs.readdirSync(config.vaultRoot);
  for (const board of config.boards) {
    const file = path.join(config.vaultRoot, board.file);
    if (fs.existsSync(file)) fs.readFileSync(file);
  }
  const probe = path.join(config.vaultRoot, `.obsidian-kanban-access-check-${process.pid}`);
  fs.writeFileSync(probe, 'probe\n', { flag: 'wx' });
  fs.unlinkSync(probe);
} catch (err) {
  outcome = `${err.code ?? 'error'}: ${err.message}`;
}
fs.writeFileSync(resultPath, outcome);
