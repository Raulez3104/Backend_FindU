const multer = require('multer');
const path = require('path');
const { uploadsDir } = require('./server');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const extname = ['.jpeg', '.jpg', '.png'].includes(path.extname(file.originalname).toLowerCase());
    const mimetype = ['image/jpeg', 'image/jpg', 'image/png'].includes(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      const error = new Error('Solo se permiten imágenes JPG, JPEG y PNG');
      error.status = 400;
      cb(error);
    }
  }
});

module.exports = upload;
