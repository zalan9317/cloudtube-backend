// 1. Feltöltés végpont (Javított jogosultság- és stream kezeléssel)
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

    // supportsAllDrives: true és requestBody használata a hibák elkerülésére
    const response = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, name, mimeType',
      supportsAllDrives: true,
    });

    // Publikussá tesszük a fájlt olvasásra
    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true,
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