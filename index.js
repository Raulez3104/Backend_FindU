require('dotenv').config(); 

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mysql = require('mysql2');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const app = express();
const PORT = process.env.PORT || 3000;

// Helper para construir URLs de imagen consistentes
function buildImageUrl(req, filename) {
  if (!filename) return null;
  const host = req.get('host');
  const proto = req.protocol || 'http';
  return `${proto}://${host}/uploads/${filename}`;
}

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
  limits: { fileSize: 5 * 1024 * 1024 },
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

// ENDPOINT: Crear reporte
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
        console.error('❌Error SQL:', err);
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
        imageUrl: buildImageUrl(req, imagePath)
      });
    }
  );
});

app.get('/reports/user/:userId', (req, res) => {
  const { userId } = req.params;

  const query = `
    SELECT 
      id, 
      title, 
      description,
      status, 
      image,
      DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') as date
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
      imageUrl: buildImageUrl(req, report.image)
    }));
    
    res.json({ reports: reportsWithImages });
  });
});

// Login con Google
app.post('/users/google-login', (req, res) => {
  const { email, name, picture } = req.body || {};
  console.log('POST /users/google-login body:', req.body);
  if (!email) return res.status(400).json({ message: 'Email es requerido' });

  const selectWithPicture = 'SELECT id, name, email, picture, is_active FROM users WHERE email = ?';
  const selectWithoutPicture = 'SELECT id, name, email, is_active FROM users WHERE email = ?';

  const runSelect = () => new Promise((resolve, reject) => {
    db.query(selectWithPicture, [email], (err, results) => {
      if (err && err.code === 'ER_BAD_FIELD_ERROR') {
        // Fallback si la columna picture no existe
        return db.query(selectWithoutPicture, [email], (err2, results2) => {
          if (err2) return reject(err2);
          // Normalizar shape agregando picture: null
          const normalized = results2.map(r => ({ ...r, picture: null }));
          resolve(normalized);
        });
      }
      if (err) return reject(err);
      resolve(results);
    });
  });

  const insertWithPicture = 'INSERT INTO users (name, email, picture, is_active) VALUES (?, ?, ?, 1)';
  const insertWithoutPicture = 'INSERT INTO users (name, email, is_active) VALUES (?, ?, 1)';

  const runInsert = () => new Promise((resolve, reject) => {
    db.query(insertWithPicture, [name || null, email, picture || null], (err, result) => {
      if (err && err.code === 'ER_BAD_FIELD_ERROR') {
        return db.query(insertWithoutPicture, [name || null, email], (err2, result2) => {
          if (err2) return reject(err2);
          resolve(result2);
        });
      }
      if (err) return reject(err);
      resolve(result);
    });
  });

  const selectByIdWithPicture = 'SELECT id, name, email, picture, is_active FROM users WHERE id = ?';
  const selectByIdWithoutPicture = 'SELECT id, name, email, is_active FROM users WHERE id = ?';

  const runSelectById = (id) => new Promise((resolve, reject) => {
    db.query(selectByIdWithPicture, [id], (err, rows) => {
      if (err && err.code === 'ER_BAD_FIELD_ERROR') {
        return db.query(selectByIdWithoutPicture, [id], (err2, rows2) => {
          if (err2) return reject(err2);
          const normalized = rows2.map(r => ({ ...r, picture: null }));
          resolve(normalized);
        });
      }
      if (err) return reject(err);
      resolve(rows);
    });
  });

  runSelect()
    .then(results => {
      if (results.length > 0) {
        const user = results[0];
        return res.json({ user });
      }
      return runInsert().then(result => runSelectById(result.insertId).then(rows => res.json({ user: rows[0] })));
    })
    .catch(err => {
      console.error('Error en /users/google-login:', err);
      return res.status(500).json({ message: 'Error en la base de datos', error: err.message, code: err.code });
    });
});

// Endpoints Usuarios
// Listar usuarios
app.get('/users', (req, res) => {
  const sql = `SELECT id, name, email, picture, is_active, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS created_at FROM users ORDER BY created_at DESC, id DESC`;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ message: 'Error al obtener usuarios' });
    res.json({ users: results });
  });
});

// Crear usuario
app.post('/users', (req, res) => {
  const { name, email, picture } = req.body;
  if (!name || !email) return res.status(400).json({ message: 'Nombre y email son requeridos' });

  db.query('SELECT id FROM users WHERE email = ?', [email], (err, found) => {
    if (err) return res.status(500).json({ message: 'Error al verificar email' });
    if (found.length > 0) return res.status(409).json({ message: 'El email ya existe', id: found[0].id });

    db.query(
      'INSERT INTO users (name, email, picture, is_active) VALUES (?, ?, ?, 1)',
      [name, email, picture || null],
      (err2, result) => {
        if (err2) return res.status(500).json({ message: 'Error al crear usuario' });
        res.status(201).json({ message: 'Usuario creado', id: result.insertId });
      }
    );
  });
});

// Activar/Desactivar usuario
app.put('/users/:id/active', (req, res) => {
  const { id } = req.params;
  let { is_active } = req.body; // 0 o 1

  if (!(is_active === 0 || is_active === 1 || is_active === '0' || is_active === '1')) {
    return res.status(400).json({ message: 'is_active debe ser 0 o 1' });
  }
  const val = is_active === 1 || is_active === '1' ? 1 : 0;

  db.query('UPDATE users SET is_active = ? WHERE id = ?', [val, id], (err, result) => {
    if (err) return res.status(500).json({ message: 'Error al actualizar estado de actividad' });
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json({ message: 'Estado de actividad actualizado', id, is_active: val });
  });
});

// Opcional: obtener usuario por id
app.get('/users/:id', (req, res) => {
  const { id } = req.params;
  db.query(
    'SELECT id, name, email, picture, is_active, DATE_FORMAT(created_at, "%Y-%m-%d %H:%i") AS created_at FROM users WHERE id = ?',
    [id],
    (err, results) => {
      if (err) return res.status(500).json({ message: 'Error al obtener usuario' });
      if (results.length === 0) return res.status(404).json({ message: 'Usuario no encontrado' });
      res.json({ user: results[0] });
    }
  );
});

// Opcional: obtener usuario por email
app.get('/users/by-email/:email', (req, res) => {
  const { email } = req.params;
  db.query(
    'SELECT id, name, email, picture, is_active, DATE_FORMAT(created_at, "%Y-%m-%d %H:%i") AS created_at FROM users WHERE email = ?',
    [email],
    (err, results) => {
      if (err) return res.status(500).json({ message: 'Error al buscar por email' });
      if (results.length === 0) return res.status(404).json({ message: 'Usuario no encontrado' });
      res.json({ user: results[0] });
    }
  );
});

// Manejo de errores de Multer
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

// Obtener todos los reportes
// Obtener todos los reportes CON INFO DE USUARIO
app.get('/reports', (req, res) => {
  const query = `
    SELECT 
      r.id,
      r.user_id,
      r.title,
      r.description,
      r.status,
      r.location,
      r.contact,
      r.image,
      r.is_active,
      r.delivered_to_services,
      DATE_FORMAT(r.created_at, '%Y-%m-%d %H:%i') as date,
      u.name as user_name,
      u.email as user_email
    FROM reports r
    LEFT JOIN users u ON r.user_id = u.id
    ORDER BY r.created_at DESC
  `;

  db.query(query, (err, results) => {
    if (err) {
      console.error('Error SQL:', err);
      return res.status(500).json({ message: 'Error al obtener los reportes' });
    }

    const reportsWithImages = results.map(report => ({
      ...report,
      imageUrl: buildImageUrl(req, report.image)
    }));

    res.json(reportsWithImages);
  });
});

// Estadísticas de reportes
// Requiere columna reports.is_active TINYINT(1) NOT NULL DEFAULT 1
app.get('/reports/stats', (req, res) => {
  const byStatusSql = `
    SELECT status, COUNT(*) AS count
    FROM reports
    GROUP BY status
  `;

  const deliveredSql = `
    SELECT
      SUM(CASE WHEN delivered_to_services = 1 THEN 1 ELSE 0 END) AS delivered_count,
      SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) AS inactive_count,
      COUNT(*) AS total
    FROM reports
  `;

  const byDateSql = `
    SELECT DATE(created_at) AS day, COUNT(*) AS count
    FROM reports
    GROUP BY DATE(created_at)
    ORDER BY day ASC
    LIMIT 30
  `;

  const byLocationSql = `
    SELECT location, COUNT(*) AS count
    FROM reports
    WHERE location IS NOT NULL AND TRIM(location) <> ''
    GROUP BY location
    ORDER BY count DESC
    LIMIT 10
  `;

  const runQuery = (sql) => new Promise((resolve, reject) => {
    db.query(sql, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });

  Promise.all([
    runQuery(byStatusSql),
    runQuery(deliveredSql),
    runQuery(byDateSql),
    runQuery(byLocationSql),
  ])
    .then(([statusRows, deliveredRows, dateRows, locationRows]) => {
      const byStatus = {};
      statusRows.forEach(r => {
        const s = r.status ? (r.status.charAt(0).toUpperCase() + r.status.slice(1)) : 'Desconocido';
        byStatus[s] = r.count;
      });

      const delivered = (deliveredRows[0] && deliveredRows[0].delivered_count) ?? 0;
      const inactive = (deliveredRows[0] && deliveredRows[0].inactive_count) ?? 0;
      const total = (deliveredRows[0] && deliveredRows[0].total) ?? 0;

      const seriesDates = dateRows.map(r => ({
        date: typeof r.day === 'string' ? r.day : new Date(r.day).toISOString().slice(0, 10),
        count: r.count
      }));

      const seriesLocations = locationRows.map(r => ({
        location: r.location,
        count: r.count
      }));

      res.json({ total, byStatus, delivered, inactive, seriesDates, seriesLocations });
    })
    .catch(err => {
      console.error('Error SQL stats:', err);
      res.status(500).json({ message: 'Error al obtener estadísticas de reportes' });
    });
});

app.post('/admins/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Email y contraseña son requeridos' });

  db.query('SELECT * FROM admins WHERE email = ?', [email], (err, results) => {
    if (err) return res.status(500).json({ message: 'Error en la base de datos', error: err.message });
    if (results.length === 0) return res.status(404).json({ message: 'Admin no encontrado' });

    const admin = results[0];
    bcrypt.compare(password, admin.password, (err, match) => {
      if (err) return res.status(500).json({ message: 'Error en la verificación de contraseña' });
      if (!match) return res.status(401).json({ message: 'Contraseña incorrecta' });

      res.json({ message: 'Login exitoso', admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } });
    });
  });
});
app.put('/reports/:id/active', (req, res) => {
const { id } = req.params;
let { is_active } = req.body; // espera 0 o 1

if (!(is_active === 0 || is_active === 1 || is_active === '0' || is_active === '1')) {
return res.status(400).json({ message: 'is_active debe ser 0 o 1' });
}

const val = is_active === 1 || is_active === '1' ? 1 : 0;

const query = 'UPDATE reports SET is_active = ? WHERE id = ?';
db.query(query, [val, id], (err, result) => {
if (err) {
console.error('Error SQL:', err);
return res.status(500).json({ message: 'Error al actualizar estado de actividad' });
}
if (result.affectedRows === 0) {
return res.status(404).json({ message: 'Reporte no encontrado' });
}
res.json({ message: 'Estado de actividad actualizado', id, is_active: val });
});
});

app.put('/reports/:id/status', (req, res) => {
const { id } = req.params;
let { status } = req.body;

if (!status || typeof status !== 'string') {
return res.status(400).json({ message: 'status es requerido' });
}
status = status.charAt(0).toUpperCase() + status.slice(1);
const allowed = ['Perdido','Encontrado','Entregado','Devuelto','Donado'];
if (!allowed.includes(status)) {
return res.status(400).json({ message: `Estado inválido. Permitidos: ${allowed.join(', ')}` });
}

const nextDelivered = status === 'Entregado' ? 1 : 0;
const sql = 'UPDATE reports SET status = ?, delivered_to_services = ? WHERE id = ?';

db.query(sql, [status, nextDelivered, id], (err, result) => {
if (err) return res.status(500).json({ message: 'Error al actualizar estado' });
if (result.affectedRows === 0) return res.status(404).json({ message: 'Reporte no encontrado' });
res.json({ message: 'Estado actualizado', id, status, delivered_to_services: nextDelivered });
});
});



app.listen(PORT, () => {
  console.log(`\nServidor corriendo en http://localhost:${PORT}`);
  console.log(`Carpeta de uploads: ${uploadsDir}`);
  console.log(`Acceso a imágenes: http://localhost:${PORT}/uploads/`);
});
