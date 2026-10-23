const multer = require('multer');

function errorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    console.error('Error de Multer:', err);
    return res.status(400).json({
      message: 'Error al subir la imagen',
      error: err.message
    });
  } else if (err) {
    console.error('Error:', err);
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
    return res.status(status).json({
      message: err.message || 'Error del servidor'
    });
  }
  next();
}

module.exports = errorHandler;
