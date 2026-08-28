const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors()); // Engedi, hogy a weboldalad kommunikáljon a szerverrel
app.use(express.json());

// Fájlok átmeneti tárolása a memóriafogyasztás elkerülése végett
const upload = multer({ dest: '/tmp/uploads/' });

// Google Drive Auth (Környezeti változóból olvassuk be a biztonság miatt)
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

// 1. Feltöltés végpont
app.post('/api/upload', upload.single('media'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nincs fájl!' });

    const fileMetadata = {
      name: req.body.title || req.file.originalname,
      description: req.body.description || '',
      parents: [FOLDER_ID],
    };

    const media = {
      mimeType: req.file.mimetype,
      // Közvetlen streamelés a lemezről a Drive-ra (memória kímélése)
      body: fs.createReadStream(req.file.path),
    };

    const response = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, name, mimeType',
    });

    // Publikussá tesszük a fájlt
    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    // Átmeneti fájl törlése a szerverről
    fs.unlinkSync(req.file.path);

    res.json({ success: true, file: response.data });
  } catch (error) {
    console.error('Feltöltési hiba:', error);
    res.status(500).json({ error: 'Hiba a feltöltés során.' });
  }
});

// 2. Fájlok listázása
app.get('/api/posts', async (req, res) => {
  try {
    const response = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and trashed = false`,
      fields: 'files(id, name, description, mimeType, createdTime)',
      orderBy: 'createdTime desc',
      pageSize: 50,
    });
    res.json({ posts: response.data.files });
  } catch (error) {
    console.error('Listázási hiba:', error);
    res.status(500).json({ error: 'Hiba a fájlok lekérésekor.' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Szerver fut a ${PORT} porton.`);
});