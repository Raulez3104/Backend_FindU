const reportService = require('../services/reportService');

function crear(req, res, next) {
  const imagenPath = req.file ? req.file.filename : null;
  const autor = { tipo: 'usuario', id: req.usuario.id };
  return reportService.crearReporte({ autor, datos: req.body, imagenPath })
    .then(result => {
      res.status(201).json({
        message: 'Reporte guardado correctamente',
        id: result.id,
        imagen: result.imagen,
        imageUrl: reportService.buildImageUrl(req, result.imagen)
      });
    })
    .catch(next);
}

function obtenerTodos(req, res) {
  reportService.obtenerTodosLosReportes()
    .then(results => {
      const reportsWithImages = results.map(report => ({
        ...report,
        imageUrl: reportService.buildImageUrl(req, report.imagen)
      }));
      res.json(reportsWithImages);
    })
    .catch(err => {
      console.error('Error SQL:', err);
      res.status(500).json({ message: 'Error al obtener los reportes' });
    });
}

async function obtenerPorUsuario(req, res, next) {
  try {
    const results = await reportService.obtenerReportesPorUsuario(
      req.params.usuarioId,
      req.usuario.id,
    );
    const reportsWithImages = results.map(report => ({
      ...report,
      imageUrl: reportService.buildImageUrl(req, report.imagen)
    }));
    return res.json({ reports: reportsWithImages });
  } catch (error) {
    return next(error);
  }
}

function obtenerPorId(req, res) {
  const { id } = req.params;

  reportService.obtenerPorId(id)
    .then(report => {
      if (!report) {
        return res.status(404).json({ message: 'Reporte no encontrado' });
      }
      res.json({
        ...report,
        imageUrl: reportService.buildImageUrl(req, report.imagen)
      });
    })
    .catch(err => {
      console.error('Error SQL:', err);
      res.status(500).json({ message: 'Error al obtener el reporte' });
    });
}

function obtenerEstadisticas(req, res) {
  reportService.obtenerEstadisticas()
    .then(stats => res.json(stats))
    .catch(err => {
      console.error('Error SQL stats:', err);
      res.status(500).json({ message: 'Error al obtener estadísticas de reportes' });
    });
}

function actualizarEstado(req, res) {
  return res.status(403).json({ message: 'Operación administrativa no habilitada' });
}

function actualizarActivo(req, res) {
  return res.status(403).json({ message: 'Operación administrativa no habilitada' });
}

module.exports = {
  crear,
  obtenerTodos,
  obtenerPorUsuario,
  obtenerPorId,
  obtenerEstadisticas,
  actualizarEstado,
  actualizarActivo,
};
