const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const upload = require('../config/upload');
const { autenticar } = require('../middleware/authMiddleware');

router.post('/', autenticar, upload.single('image'), reportController.crear);
router.get('/', reportController.obtenerTodos);
router.get('/stats', reportController.obtenerEstadisticas);
router.get('/usuario/:usuarioId', autenticar, reportController.obtenerPorUsuario);
router.get('/:id', reportController.obtenerPorId);
router.put('/:id/active', reportController.actualizarActivo);
router.put('/:id/status', reportController.actualizarEstado);

module.exports = router;
