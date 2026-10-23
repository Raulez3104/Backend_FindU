const catalogService = require('../services/catalogService');

function obtenerCategorias(req, res, next) {
  return catalogService.obtenerCategoriasActivas()
    .then(categorias => res.json(categorias))
    .catch(next);
}

function obtenerUbicaciones(req, res, next) {
  return catalogService.obtenerUbicacionesActivas(req.query.campus)
    .then(ubicaciones => res.json(ubicaciones))
    .catch(next);
}

module.exports = { obtenerCategorias, obtenerUbicaciones };
