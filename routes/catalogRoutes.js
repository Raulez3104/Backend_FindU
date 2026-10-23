const express = require('express');
const catalogController = require('../controllers/catalogController');

const rutasCategorias = express.Router();
const rutasUbicaciones = express.Router();

rutasCategorias.get('/', catalogController.obtenerCategorias);
rutasUbicaciones.get('/', catalogController.obtenerUbicaciones);

module.exports = { rutasCategorias, rutasUbicaciones };
