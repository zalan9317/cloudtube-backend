const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: '/tmp/uploads/' });

const oauth2Client = new google.auth.OAuth2(
  (process.env.CLIENT_ID || '').trim(),
  (process.env.CLIENT_SECRET || '').trim()
);

oauth2Client.setCredentials({ refresh_token: (process.env.REFRESH_TOKEN || '').trim() });
const drive = google.drive({ version: 'v3', auth: oauth2Client });
const FOLDER_ID = (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();

// Metaadat cache a RAM és a processzor kímélésére
const metaCache = new Map();

async function getFileMetadata(fileId) {
  const now = Date.now();
  if (metaCache.has(fileId)) {
    const cached = metaCache.get(fileId);
    if (now - cached.time < 1000 * 60 * 30) return cached; // 30 percig érvényes
  }
  const meta = await drive.files.get({
    fileId: fileId,
    fields: 'mimeType, size',
    supportsAllDrives: true,
  });
  const data = {
    size: parseInt(meta.data.size, 10),
    mimeType: meta.data.mimeType || 'video/mp4',
    time: now
  };
  metaCache.set(fileId, data);
  return data;
}

app.get('/', (req, res) => res.send('CloudTube szerver rendben fut.'));

// 1. Feltöltés
app.post('/api/upload', upload.single('media'), async (req, res) => {
  let tempFilePath = req.file ? req.file.path : null;
  try {
    if (!req.file) return res.status(400).json({ error: 'Nem érkezett fájl.' });
    const fileMetadata = { name: req.body.title || req.file.originalname, description: req.body.description || '', parents: [FOLDER_ID], appProperties: { likes: "0" } };
    const media = { mimeType: req.file.mimetype, body: fs.createReadStream(req.file.path) };
    const response = await drive.files.create({ requestBody: fileMetadata, media: media, fields: 'id, name, mimeType', supportsAllDrives: true });
    try { await drive.permissions.create({ fileId: response.data.id, requestBody: { role: 'reader', type: 'anyone' }, supportsAllDrives: true }); } catch (e) {}
    if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    res.json({ success: true, file: response.data });
  } catch (error) {
    if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    res.status(500).json({ error: 'Feltöltési hiba.' });
  }
});

// 2. Listázás
app.get('/api/posts', async (req, res) => {
  try {
    const response = await drive.files.list({ q: `'${FOLDER_ID}' in parents and trashed = false`, fields: 'files(id, name, description, mimeType, createdTime, appProperties)', orderBy: 'createdTime desc', pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true });
    const posts = response.data.files.map(file => ({ id: file.id, name: file.name, description: file.description || '', mimeType: file.mimeType, createdTime: file.createdTime, likes: (file.appProperties && file.appProperties.likes) ? parseInt(file.appProperties.likes) : 0 }));
    res.json({ posts });
  } catch (error) { res.status(500).json({ error: 'Lekérési hiba.' }); }
});

// 3. Like
app.post('/api/like/:id', async (req, res) => {
  try {
    const fileId = req.params.id.replace(/\.mp4$/i, '');
    const file = await drive.files.get({ fileId: fileId, fields: 'appProperties', supportsAllDrives: true });
    const newLikes = ((file.data.appProperties && file.data.appProperties.likes) ? parseInt(file.data.appProperties.likes) : 0) + 1;
    await drive.files.update({ fileId: fileId, requestBody: { appProperties: { likes: newLikes.toString() } }, supportsAllDrives: true });
    res.json({ success: true, likes: newLikes });
  } catch (error) { res.status(500).json({ error: 'Like hiba.' }); }
});

// 4. Discord HEAD vizsgálat (azonnali válasz letöltés nélkül)
app.head('/api/media/:id', async (req, res) => {
  try {
    const fileId = req.params.id.replace(/\.mp4$/i, '');
    const meta = await getFileMetadata(fileId);
    res.writeHead(200, {
      'Content-Length': meta.size,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes'
    });
    res.end();
  } catch (error) {
    res.status(500).end();
  }
});

// 5. ULTRALIGHT MÉDIA STREAMELÉS (Max 4MB szeletekben a laggmentes futáshoz)
app.get('/api/media/:id', async (req, res) => {
  let driveStream = null;

  // Ha a felhasználó továbbteker vagy bezárja a lapot, AZONNAL leállítjuk a Google Drive letöltést!
  req.on('close', () => {
    if (driveStream) {
      try { driveStream.destroy(); } catch (e) {}
      driveStream = null;
    }
  });

  try {
    const fileId = req.params.id.replace(/\.mp4$/i, '');
    const meta = await getFileMetadata(fileId);
    const fileSize = meta.size;
    const mimeType = meta.mimeType;
    const range = req.headers.range;

    // Ha a videó nem létezik vagy 0 bájt
    if (!fileSize) {
      return res.status(404).send('Fájl nem található.');
    }

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      
      // Szigorú 4 MB-os szeletméret (CHUNK_SIZE): Nem engedi elfogyni a RAM-ot!
      const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB
      let end = parts[1] ? parseInt(parts[1], 10) : start + CHUNK_SIZE - 1;
      if (end >= fileSize) end = fileSize - 1;

      const chunksize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mimeType,
      });

      const response = await drive.files.get(
        { fileId: fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream', headers: { Range: `bytes=${start}-${end}` } }
      );
      
      driveStream = response.data;
      driveStream.pipe(res);

      driveStream.on('error', () => {
        if (!res.headersSent) res.status(500).end();
        else res.end();
      });
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
      });

      const response = await drive.files.get(
        { fileId: fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' }
      );

      driveStream = response.data;
      driveStream.pipe(res);

      driveStream.on('error', () => {
        if (!res.headersSent) res.status(500).end();
        else res.end();
      });
    }
  } catch (error) {
    if (!res.headersSent) res.status(500).send('Hiba a fájl betöltésekor.');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Fut a porton: ${PORT}`));
