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

oauth2Client.setCredentials({
  refresh_token: (process.env.REFRESH_TOKEN || '').trim()
});

const drive = google.drive({ version: 'v3', auth: oauth2Client });
const FOLDER_ID = (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();

app.get('/', (req, res) => {
  res.send('CloudTube szerver rendben fut.');
});

// Feltöltés
app.post('/api/upload', upload.single('media'), async (req, res) => {
  let tempFilePath = req.file ? req.file.path : null;
  try {
    if (!req.file) return res.status(400).json({ error: 'Nem érkezett fájl.' });

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

    try {
      await drive.permissions.create({
        fileId: response.data.id,
        requestBody: { role: 'reader', type: 'anyone' },
        supportsAllDrives: true,
      });
    } catch (permErr) {
      console.warn('Jogosultság figyelmeztetés:', permErr.message);
    }

    if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    res.json({ success: true, file: response.data });
  } catch (error) {
    console.error('Feltöltési hiba:', error.response ? error.response.data : error);
    if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    res.status(500).json({ error: 'Feltöltési hiba.' });
  }
});

// Listázás
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
    console.error('Listázási hiba:', error.response ? error.response.data : error);
    res.status(500).json({ error: 'Lekérési hiba.' });
  }
});

// Like
app.post('/api/like/:id', async (req, res) => {
  try {
    const fileId = req.params.id;
    const file = await drive.files.get({
      fileId: fileId,
      fields: 'appProperties',
      supportsAllDrives: true,
    });

    const currentLikes = (file.data.appProperties && file.data.appProperties.likes) 
      ? parseInt(file.data.appProperties.likes) 
      : 0;
    const newLikes = currentLikes + 1;

    await drive.files.update({
      fileId: fileId,
      requestBody: { appProperties: { likes: newLikes.toString() } },
      supportsAllDrives: true,
    });

    res.json({ success: true, likes: newLikes });
  } catch (error) {
    console.error('Like hiba:', error.response ? error.response.data : error);
    res.status(500).json({ error: 'Like hiba.' });
  }
});

// Közvetlen Média Stream
app.get('/api/media/:id', async (req, res) => {
  try {
    const fileId = req.params.id;
    const meta = await drive.files.get({
      fileId: fileId,
      fields: 'mimeType',
      supportsAllDrives: true,
    });

    if (meta.data.mimeType) res.setHeader('Content-Type', meta.data.mimeType);

    const stream = await drive.files.get(
      { fileId: fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );

    stream.data.pipe(res);
  } catch (error) {
    console.error('Stream hiba:', error);
    res.status(500).send('Stream hiba.');
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Fut a porton: ${PORT}`));