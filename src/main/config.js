// App-level config (not business data): which data folder to open.
// Stored as JSON in Electron's userData folder, e.g.
//   Windows: %APPDATA%\MMA Books\config.json
import fs from 'node:fs';
import path from 'node:path';

export function configPath(userDataDir) {
  return path.join(userDataDir, 'config.json');
}

export function readConfig(userDataDir) {
  try {
    const raw = fs.readFileSync(configPath(userDataDir), 'utf8');
    const c = JSON.parse(raw);
    return typeof c === 'object' && c ? c : {};
  } catch {
    return {};
  }
}

export function writeConfig(userDataDir, config) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const file = configPath(userDataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, file);
}
