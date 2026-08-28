const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: '/tmp/uploads/' });

// OAuth2 hitelesítés a saját Google fiókoddal!
const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  "https://developers.google.com/oauthplayground"
);

oauth2Client.setCredentials({
  refresh_token: process.env.REFRESH_TOKEN
});

const drive = google.drive({ version: 'v3', auth: oauth2Client });
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

app.get('/', (req, res) => {
  res.send('A CloudTube szerver a te fiókoddal sikeresen fut! 🚀');
});

// 1. Feltöltés (Közvetlenül a te fiókodba és tárhelyedre)
app.post('/api/upload', upload.single('media'), async (req, res) => {
  let tempFilePath = req.file ? req.file.path : null;
  try {
    if (!req.file) return res.status(400).json({ error: 'Nincs fájl!' });

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
    });

    // Publikussá tesszük a megtekintéshez
    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }

    res.json({ success: true, file: response.data });
  } catch (error) {
    console.error('Feltöltési hiba részletei:', error.response ? error.response.data : error);
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
    res.status(500).json({ error: 'Hiba a feltöltés során.' });
  }
});

// 2. Fájlok listázása
app.get('/api/posts', async (req, res) => {
  try {
    const response = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and trashed = false`,
      fields: 'files(id, name, description, mimeType, createdTime, appProperties)',
      orderBy: 'createdTime desc',
      pageSize: 50,
    });
    
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

// 3. Like mentése
app.post('/api/like/:id', async (req, res) => {
  try {
    const fileId = req.params.id;
    const file = await drive.files.get({ fileId: fileId, fields: 'appProperties' });
    
    let currentLikes = 0;
    if (file.data.appProperties && file.data.appProperties.likes) {
      currentLikes = parseInt(file.data.appProperties.likes);
    }

    const newLikes = currentLikes + 1;

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