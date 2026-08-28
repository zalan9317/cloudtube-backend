const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// Feltöltési ideiglenes mappa beállítása
const upload = multer({ dest: '/tmp/uploads/' });

// OAuth2 kliens konfiguráció a felesleges whitespace hibák kiküszöbölésével
const oauth2Client = new google.auth.OAuth2(
  (process.env.CLIENT_ID || '').trim(),
  (process.env.CLIENT_SECRET || '').trim()
);

oauth2Client.setCredentials({
  refresh_token: (process.env.REFRESH_TOKEN || '').trim()
});

const drive = google.drive({ version: 'v3', auth: oauth2Client });
const FOLDER_ID = (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();

// Teszt végpont
app.get('/', (req, res) => {
  res.send('A CloudTube backend szerver sikeresen fut! 🚀');
});

// 1. Média feltöltése közvetlenül a Drive-ra
app.post('/api/upload', upload.single('media'), async (req, res) => {
  let tempFilePath = req.file ? req.file.path : null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nem érkezett fájl a kérésben!' });
    }

    const fileMetadata = {
      name: req.body.title || req.file.originalname,
      description: req.body.description || '',
      parents: [FOLDER_ID],
      appProperties: { likes: "0" }
    };

    const media = {
      mimeType: req.file.mimetype,
      body: fs.createReadStream(req.file.path),
    };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, name, mimeType',
      supportsAllDrives: true,
    });

    // Publikus olvasási jog biztosítása a beágyazáshoz
    try {
      await drive.permissions.create({
        fileId: response.data.id,
        requestBody: { role: 'reader', type: 'anyone' },
        supportsAllDrives: true,
      });
    } catch (permErr) {
      console.warn('Jogosultság beállítási figyelmeztetés:', permErr.message);
    }

    // Ideiglenes szerverfájl eltávolítása
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }

    res.json({ success: true, file: response.data });
  } catch (error) {
    console.error('Feltöltési hiba részletei:', error.response ? error.response.data : error);
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
    res.status(500).json({ error: 'Hiba történt a feltöltés során.' });
  }
});

// 2. Posztok és médiafájlok listázása
app.get('/api/posts', async (req, res) => {
  try {
    const response = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and trashed = false`,
      fields: 'files(id, name, description, mimeType, createdTime, appProperties)',
      orderBy: 'createdTime desc',
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const posts = response.data.files.map(file => ({
      id: file.id,
      name: file.name,
      description: file.description || '',
      mimeType: file.mimeType,
      createdTime: file.createdTime,
      likes: (file.appProperties && file.appProperties.likes) ? parseInt(file.appProperties.likes) : 0
    }));

    res.json({ posts });
  } catch (error) {
    console.error('Listázási hiba részletei:', error.response ? error.response.data : error);
    res.status(500).json({ error: 'Hiba a fájlok lekérésekor.' });
  }
});

// 3. Like rögzítése
app.post('/api/like/:id', async (req, res) => {
  try {
    const fileId = req.params.id;
    const file = await drive.files.get({
      fileId: fileId,
      fields: 'appProperties',
      supportsAllDrives: true,
    });

    let currentLikes = 0;
    if (file.data.appProperties && file.data.appProperties.likes) {
      currentLikes = parseInt(file.data.appProperties.likes);
    }

    const newLikes = currentLikes + 1;

    await drive.files.update({
      fileId: fileId,
      requestBody: {
        appProperties: { likes: newLikes.toString() }
      },
      supportsAllDrives: true,
    });

    res.json({ success: true, likes: newLikes });
  } catch (error) {
    console.error('Hiba a like mentésekor:', error.response ? error.response.data : error);
    res.status(500).json({ error: 'Nem sikerült rögzíteni a kedvelést.' });
  }
});

// 4. Média streamelés és közvetlen megjelenítés
app.get('/api/media/:id', async (req, res) => {
  try {
    const fileId = req.params.id;
    const meta = await drive.files.get({
      fileId: fileId,
      fields: 'mimeType, size',
      supportsAllDrives: true,
    });

    if (meta.data.mimeType) {
      res.setHeader('Content-Type', meta.data.mimeType);
    }

    const stream = await drive.files.get(
      { fileId: fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );

    stream.data.pipe(res);
  } catch (error) {
    console.error('Stream hiba:', error);
    res.status(500).send('Nem sikerült betölteni a médiafájlt.');
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`CloudTube szerver fut a ${PORT} porton.`);
});