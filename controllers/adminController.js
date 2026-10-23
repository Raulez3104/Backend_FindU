const adminService = require('../services/adminService');

function login(req, res) {
  const { email, correo, password, contrasena } = req.body;
  
  const correoVal = correo || email;
  const contrasenaVal = contrasena || password;

  adminService.login(correoVal, contrasenaVal)
    .then(admin => res.json({ message: 'Login exitoso', admin }))
    .catch(err => {
      if (err.message && err.message.includes('requerido')) {
        return res.status(400).json({ message: err.message });
      }
      if (err.notFound) return res.status(404).json({ message: err.message });
      if (err.unauthorized) return res.status(401).json({ message: err.message });
      res.status(500).json({ message: 'Error en la base de datos', error: err.message });
    });
}

module.exports = { login };
