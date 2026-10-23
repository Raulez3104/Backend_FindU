require('dotenv').config();

const { createServer } = require('./config/server');
const reportRoutes = require('./routes/reportRoutes');
const userRoutes = require('./routes/userRoutes');
const adminRoutes = require('./routes/adminRoutes');
const { rutasCategorias, rutasUbicaciones } = require('./routes/catalogRoutes');
const errorHandler = require('./middleware/errorHandler');

// App ensamblada SIN listen: la usa Supertest en tests/index.js arranca el servidor.
const app = createServer();

app.use('/reportes', reportRoutes);
app.use('/usuarios', userRoutes);
app.use('/administradores', adminRoutes);
app.use('/categorias', rutasCategorias);
app.use('/ubicaciones', rutasUbicaciones);

app.use(errorHandler);

module.exports = app;
