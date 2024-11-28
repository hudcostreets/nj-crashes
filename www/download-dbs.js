const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const https = require('https');

const baseS3Url = 'https://nj-crashes.s3.amazonaws.com';
const files = [
  { path: 'njdot/data/cmymc.db' },
  { path: 'njdot/data/crashes.db' },
  { path: 'njdot/data/drivers.db' },
  { path: 'njdot/data/occupants.db' },
  { path: 'njdot/data/pedestrians.db' },
  { path: 'njdot/data/vehicles.db' },
  { path: 'njsp/data/crashes.db' }
];

async function downloadFile(url, destPath) {
  const dir = path.dirname(destPath);
  await fsp.mkdir(dir, { recursive: true });

  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download ${url}: ${response.statusCode}`));
        return;
      }

      const file = fs.createWriteStream(destPath);
      response.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve();
      });

      file.on('error', async (err) => {
        try {
          await fsp.unlink(destPath);
        } catch (e) {
          // Ignore error if file doesn't exist
        }
        reject(err);
      });
    }).on('error', reject);
  });
}

async function downloadAll() {
  console.log('Starting downloads...');

  for (const file of files) {
    const url = `${baseS3Url}/${file.path}`;
    const destPath = path.join('public', file.path);

    console.log(`Downloading ${url} to ${destPath}`);
    await downloadFile(url, destPath);
    console.log(`Finished downloading ${file.path}`);
  }

  console.log('All downloads complete');
}

downloadAll().catch(err => {
  console.error(err);
  process.exit(1);
});
