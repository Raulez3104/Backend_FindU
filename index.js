require('dotenv').config(); // Cargar variables de entorno

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mysql = require('mysql2');
const path = require('path');
const fs = require('fs');

// Configuración de Express
const app = express();
const PORT = process.env.PORT || 3000;

// Crear carpeta uploads si no existe
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('Carpeta uploads/ creada');
}

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(uploadsDir));

// Configuración de Multer para subir imágenes
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
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB límite
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Solo se permiten imágenes (jpeg, jpg, png, gif, webp)'));
    }
  }
});

// Conexión a MySQL usando variables del .env
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// Conectar a la BD
db.connect(err => {
  if (err) {
    console.error('Error al conectar a la BD:', err);
    process.exit(1);
  } else {
    console.log('Conectado a MySQL - Base de datos:', process.env.DB_NAME);
  }
});

// ========================================
// ENDPOINT: Crear reporte
// ========================================
app.post('/reports', upload.single('image'), (req, res) => {
  console.log('Nueva solicitud POST /reports');
  console.log('Body:', req.body);
  console.log('File:', req.file);

  const { user_id, title, description, location, contact, status } = req.body;
  const imagePath = req.file ? req.file.filename : null;

  if (!user_id || !title || !description || !location || !contact || !status) {
    console.log('Validación fallida: campos incompletos');
    return res.status(400).json({ 
      message: 'Todos los campos son obligatorios',
      received: { user_id, title, description, location, contact, status }
    });
  }

  const query = `
    INSERT INTO reports (user_id, title, description, location, contact, status, image)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  db.query(
    query,
    [user_id, title, description, location, contact, status, imagePath],
    (err, result) => {
      if (err) {
        console.error('❌ Error SQL:', err);
        return res.status(500).json({ 
          message: 'Error al guardar en la base de datos',
          error: err.message 
        });
      }
      
      console.log('Reporte guardado con ID:', result.insertId);
      
      res.status(201).json({
        message: 'Reporte guardado correctamente',
        id: result.insertId,
        image: imagePath,
        imageUrl: imagePath ? `http://localhost:${PORT}/uploads/${imagePath}` : null
      });
    }
  );
});

// ========================================
// Obtener reportes por usuario
// ========================================
app.get('/reports/user/:userId', (req, res) => {
  const { userId } = req.params;

  const query = `
    SELECT 
      id, 
      title, 
      status, 
      image,
      DATE_FORMAT(created_at, '%Y-%m-%d') as date
    FROM reports
    WHERE user_id = ?
    ORDER BY created_at DESC
  `;

  db.query(query, [userId], (err, results) => {
    if (err) {
      console.error('Error SQL:', err);
      return res.status(500).json({ message: 'Error al obtener los reportes' });
    }
    
    const reportsWithImages = results.map(report => ({
      ...report,
      imageUrl: report.image ? `http://localhost:${PORT}/uploads/${report.image}` : null
    }));
    
    res.json({ reports: reportsWithImages });
  });
});

// ========================================
// Login con Google
// ========================================
app.post('/users/google-login', (req, res) => {
  const { email, name, picture } = req.body;

  if (!email) {
    return res.status(400).json({ message: 'Email es requerido' });
  }

  db.query('SELECT * FROM users WHERE email = ?', [email], (err, results) => {
    if (err) {
      console.error('Error SQL:', err);
      return res.status(500).json({ message: 'Error en la base de datos' });
    }

    if (results.length > 0) {
      console.log('Usuario existente:', results[0].email);
      return res.json({ user: results[0] });
    } else {
      db.query(
        'INSERT INTO users (name, email, picture) VALUES (?, ?, ?)',
        [name, email, picture],
        (err, result) => {
          if (err) {
            console.error(' Error al crear usuario:', err);
            return res.status(500).json({ message: 'Error al crear usuario' });
          }

          db.query('SELECT * FROM users WHERE id = ?', [result.insertId], (err2, newUser) => {
            if (err2) {
              console.error('Error SQL:', err2);
              return res.status(500).json({ message: 'Error en la base de datos' });
            }
            console.log(' Usuario creado:', newUser[0].email);
            res.json({ user: newUser[0] });
          });
        }
      );
    }
  });
});

// ========================================
// Crear usuario manual (opcional)
// ========================================
app.post('/users', (req, res) => {
  const { name, email, picture } = req.body;
  const query = `INSERT INTO users (name, email, picture) VALUES (?, ?, ?)`;
  
  db.query(query, [name, email, picture], (err, result) => {
    if (err) {
      console.error('❌ Error SQL:', err);
      return res.status(500).json({ message: 'Error al crear usuario' });
    }
    res.status(201).json({ message: 'Usuario creado', id: result.insertId });
  });
});

// ========================================
// Manejo de errores de Multer
// ========================================
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error('❌ Error de Multer:', err);
    return res.status(400).json({ 
      message: 'Error al subir la imagen',
      error: err.message 
    });
  } else if (err) {
    console.error('Error:', err);
    return res.status(500).json({ 
      message: err.message || 'Error del servidor' 
    });
  }
  next();
});

// ========================================
// Obtener todos los reportes
// ========================================
app.get('/reports', (req, res) => {
  const query = `
    SELECT 
      id,
      title,
      status,
      location,
      image,
      DATE_FORMAT(created_at, '%Y-%m-%d') as date
    FROM reports
    ORDER BY created_at DESC
  `;

  db.query(query, (err, results) => {
    if (err) {
      console.error('❌ Error SQL:', err);
      return res.status(500).json({ message: 'Error al obtener los reportes' });
    }

    const reportsWithImages = results.map(report => ({
      ...report,
      imageUrl: report.image ? `http://localhost:${PORT}/uploads/${report.image}` : null
    }));

    res.json(reportsWithImages);
  });
});

// ========================================
// START SERVER
// ========================================
app.listen(PORT, () => {
  console.log(`\nServidor corriendo en http://localhost:${PORT}`);
  console.log(`Carpeta de uploads: ${uploadsDir}`);
  console.log(`Acceso a imágenes: http://localhost:${PORT}/uploads/`);
});

module.exports = app;