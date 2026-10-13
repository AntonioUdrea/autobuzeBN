const fs = require('fs');
const { execSync } = require('child_process');

const LAST_SEEN_FILE = 'data/last-seen.json';
const HISTORY_FILE = 'data/history.csv';
const HEADER = 'date,operator,vehicleId,route';


function csvField(value) {
  const text = String(value);

  return /[",\n]/.test(text)
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}


function git(command) {
  execSync(`git ${command}`, { stdio: 'inherit' });
}


function push() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      git('push origin HEAD:main');
      return;
    } catch (err) {
      if (attempt === 3) throw err;
      git('fetch origin main');
      git('rebase origin/main');
    }
  }
}


function run() {

  if (!fs.existsSync(LAST_SEEN_FILE)) {
    console.log('No last seen file yet. Nothing to archive.');
    return;
  }

  const lastSeen = JSON.parse(
    fs.readFileSync(LAST_SEEN_FILE, 'utf8')
  );

  // Lines already in the history, used to avoid duplicates
  const existing = new Set(
    fs.existsSync(HISTORY_FILE)
      ? fs.readFileSync(HISTORY_FILE, 'utf8').split(/\r?\n/)
      : []
  );

  const newLines = [];

  for (const [operator, vehicles] of Object.entries(lastSeen)) {
    for (const [vehicleId, entry] of Object.entries(vehicles)) {

      // Older entries were just a date string
      const date = typeof entry === 'string' ? entry : entry?.date;

      if (!date) continue;

      const routes =
        entry?.routes?.length ? entry.routes
          : entry?.route ? [entry.route]
            : [''];

      for (const route of routes) {

        const line = [date, operator, vehicleId, route]
          .map(csvField)
          .join(',');

        if (!existing.has(line)) {
          newLines.push(line);
        }
      }
    }
  }

  if (newLines.length === 0) {
    console.log('History is already up to date.');
    return;
  }

  newLines.sort();

  fs.mkdirSync('data', { recursive: true });

  if (!fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, HEADER + '\n', 'utf8');
  }

  fs.appendFileSync(HISTORY_FILE, newLines.join('\n') + '\n', 'utf8');

  console.log(`Added ${newLines.length} history row(s).`);

  git('config user.name "github-actions[bot]"');
  git('config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
  git(`add ${HISTORY_FILE}`);
  git('commit -m "Update vehicle history [skip ci]"');
  git('fetch origin main');
  git('rebase origin/main');
  push();

  console.log('Vehicle history pushed.');
}


run();
