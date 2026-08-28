const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: '/tmp/uploads/' });

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

// Teszt végpont, hogy lásd, él-e a szerver
app.get('/', (req, res) => {
  res.send('A CloudTube szerver sikeresen fut! 🚀');
});

// 1. Feltöltés (Like számláló 0-ról indul)
app.post('/api/upload', upload.single('media'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nincs fájl!' });

    const fileMetadata = {
      name: req.body.title || req.file.originalname,
      description: req.body.description || '',
      parents: [FOLDER_ID],
      appProperties: { likes: "0" } // Like-ok mentése a fájlhoz
    };

    const media = {
      mimeType: req.file.mimetype,
      body: fs.createReadStream(req.file.path),
    };

    const response = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, name, mimeType',
    });

    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    fs.unlinkSync(req.file.path);
    res.json({ success: true, file: response.data });
  } catch (error) {
    console.error('Feltöltési hiba:', error);
    res.status(500).json({ error: 'Hiba a feltöltés során.' });
  }
});

// 2. Fájlok és Like-ok lekérése
app.get('/api/posts', async (req, res) => {
  try {
    const response = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and trashed = false`,
      fields: 'files(id, name, description, mimeType, createdTime, appProperties)',
      orderBy: 'createdTime desc',
      pageSize: 50,
    });
    
    // Like-ok kinyerése a fájl adataiból
    const posts = response.data.files.map(file => ({
      ...file,
      likes: (file.appProperties && file.appProperties.likes) ? parseInt(file.appProperties.likes) : 0
    }));

    res.json({ posts: posts });
  } catch (error) {
    console.error('Listázási hiba:', error);
    res.status(500).json({ error: 'Hiba a fájlok lekérésekor.' });
  }
});

// 3. ÚJ: Like-olás mentése a szerverre
app.post('/api/like/:id', async (req, res) => {
  try {
    const fileId = req.params.id;
    
    // Lekérjük az eddigi like-okat
    const file = await drive.files.get({ fileId: fileId, fields: 'appProperties' });
    let currentLikes = 0;
    if (file.data.appProperties && file.data.appProperties.likes) {
      currentLikes = parseInt(file.data.appProperties.likes);
    }

    const newLikes = currentLikes + 1;

    // Visszamentjük a frissített like-ot a Drive-ra
    await drive.files.update({
      fileId: fileId,
      requestBody: {
        appProperties: { likes: newLikes.toString() }
      }
    });

    res.json({ success: true, likes: newLikes });
  } catch (error) {
    console.error('Hiba a like mentésekor:', error);
    res.status(500).json({ error: 'Nem sikerült a like mentése.' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Szerver fut a ${PORT} porton.`));