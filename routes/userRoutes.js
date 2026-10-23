const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const {
  autenticar,
  bloquearRutaNoEstudiantil,
} = require('../middleware/authMiddleware');

router.post('/iniciar-sesion-google', userController.iniciarSesionGoogle);
router.get('/', autenticar, bloquearRutaNoEstudiantil);
router.post('/', autenticar, bloquearRutaNoEstudiantil);
router.get('/by-email/:email', autenticar, bloquearRutaNoEstudiantil);
router.put('/:id/active', autenticar, bloquearRutaNoEstudiantil);
router.get('/:id', autenticar, userController.obtenerPorId);

module.exports = router;
