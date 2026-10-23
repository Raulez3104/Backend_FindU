require('dotenv').config();

const app = require('./app');
const { uploadsDir } = require('./config/server');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`\nServidor corriendo en http://localhost:${PORT}`);
  console.log(`Carpeta de uploads: ${uploadsDir}`);
  console.log(`Acceso a imágenes: http://localhost:${PORT}/uploads/`);
});
