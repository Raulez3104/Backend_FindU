// HTTP real (Express/Multer/servicios), solo PostgreSQL simulado: ninguna fila persistente.
jest.mock('../config/database', () => ({ query: jest.fn(), connect: jest.fn() }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const app = require('../app');
const pool = require('../config/database');
const upload = require('../config/upload');
const servicio = require('../services/reportService');
const userService = require('../services/userService');

const datosValidos = {
  tipo_reporte: 'perdido', titulo: 'Cuaderno',
  descripcion: 'Cuaderno azul', contacto: 'Contacto de prueba', categoria_id: '2',
  fecha_incidente: '2020-01-01', campus: 'principal', ubicacion_otro: 'Patio',
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XcAAAAASUVORK5CYII=', 'base64');
let archivos;
let cliente;
const jwtSecret = 'secreto-pruebas-reportes-t7';
const jwtSecretAnterior = process.env.JWT_SECRET;
const token = jwt.sign({ sub: '42', ambito: 'estudiante' }, jwtSecret, {
  algorithm: 'HS256', issuer: 'FindU', expiresIn: '1h',
});

function alta(datos = datosValidos, archivo = { nombre: 'foto.png', mime: 'image/png', contenido: png }, campo = 'image', conJwt = true) {
  let solicitud = request(app).post('/reportes');
  if (conJwt) solicitud = solicitud.set('Authorization', `Bearer ${token}`);
  for (const [clave, valor] of Object.entries(datos)) solicitud = solicitud.field(clave, valor);
  if (archivo) solicitud = solicitud.attach(campo, archivo.contenido || png, {
    filename: archivo.nombre, contentType: archivo.mime,
  });
  return solicitud;
}

beforeEach(() => {
  process.env.JWT_SECRET = jwtSecret;
  archivos = new Set();
  pool.query.mockReset().mockImplementation(async (sql) => {
    if (/^SELECT id FROM (usuarios|categorias)/.test(sql)) return { rows: [{ id: 1 }] };
    throw new Error(`Consulta no prevista: ${sql}`);
  });
  cliente = {
    query: jest.fn(async (sql) => {
      if (/INSERT INTO reportes/.test(sql)) return { rows: [{ id: 321 }] };
      if (/INSERT INTO historial/.test(sql) || ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      throw new Error(`Escritura no prevista: ${sql}`);
    }),
    release: jest.fn(),
  };
  pool.connect.mockReset().mockResolvedValue(cliente);
  jest.spyOn(userService, 'obtenerPorId').mockResolvedValue([{
    id: 42, nombre: 'Estudiante', correo: 'estudiante@example.invalid', foto: null, activo: true,
  }]);
  jest.spyOn(console, 'error').mockImplementation(() => {});
  // Registrar solo las rutas creadas por este test, incluso cuando la validación falla.
  const manejar = upload.storage._handleFile;
  jest.spyOn(upload.storage, '_handleFile').mockImplementation(function (req, file, cb) {
    manejar.call(this, req, file, (error, info) => {
      if (info && info.path) archivos.add(info.path);
      cb(error, info);
    });
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const ruta of archivos) {
    try { fs.unlinkSync(ruta); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const ruta of archivos) expect(fs.existsSync(ruta)).toBe(false);
});

afterAll(() => {
  if (jwtSecretAnterior === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = jwtSecretAnterior;
});

describe('Contrato HTTP del alta: rechazo sin consultas ni escritura', () => {
  const sin = (clave) => { const datos = { ...datosValidos }; delete datos[clave]; return datos; };
  test.each([
    ...['titulo', 'descripcion', 'contacto'].map((clave) => [clave + ' vacío', { ...datosValidos, [clave]: '   ' }, new RegExp(clave)]),
    ...['categoria_id', 'fecha_incidente', 'campus'].map((clave) => [clave + ' ausente', sin(clave), new RegExp(clave)]),
    ['ubicación doble', { ...datosValidos, ubicacion_id: '4' }, /ubicación/],
    ['ubicación ausente', sin('ubicacion_otro'), /ubicación/],
    ['alias inglés', { ...datosValidos, title: 'Otro' }, /title/],
    ['tipo contradictorio', { ...datosValidos, estado: 'encontrado' }, /estado/],
    ['fecha futura', { ...datosValidos, fecha_incidente: '9999-12-31' }, /fecha_incidente/],
  ])('%s → 400 comprensible', async (_, datos, mensaje) => {
    const res = await alta(datos);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: expect.stringMatching(mensaje) });
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test.each(['usuario_id', 'user_id', 'administrador_id', 'ubicacion'])(
    '%s retirada → 400 específico sin persistencia',
    async (clave) => {
      const datos = { ...datosValidos, [clave]: clave === 'ubicacion' ? 'Biblioteca' : '42' };
      const res = await alta(datos);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ message: `Campo retirado del alta: ${clave}` });
      expect(pool.query).not.toHaveBeenCalled();
      expect(pool.connect).not.toHaveBeenCalled();
    },
  );

  test('sin JWT responde 401 antes de Multer y del servicio', async () => {
    const crearReporte = jest.spyOn(servicio, 'crearReporte');
    const res = await alta(datosValidos, { nombre: 'foto.png', mime: 'image/png' }, 'image', false);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Autenticación requerida' });
    expect(archivos.size).toBe(0);
    expect(userService.obtenerPorId).not.toHaveBeenCalled();
    expect(crearReporte).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test.each(['perdido', 'encontrado'])('sin foto (%s) → 400 sin persistencia', async (tipo) => {
    const res = await alta({ ...datosValidos, tipo_reporte: tipo }, null);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: expect.stringMatching(/fotografía/) });
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('T5 revisión: límites del esquema en el contrato HTTP multipart', () => {
  function conCampo(campo, valor) {
    const datos = { ...datosValidos, [campo]: valor };
    if (campo === 'ubicacion_id') delete datos.ubicacion_otro;
    return datos;
  }

  function simularCatalogos() {
    pool.query.mockImplementation(async (sql, valores) => {
      if (/^SELECT id FROM (usuarios|categorias|ubicaciones)/.test(sql)) {
        return { rows: [{ id: valores[0] }] };
      }
      // Nombre legacy inexistente: obliga a validar el fallback a texto libre.
      if (/^SELECT id, activo FROM ubicaciones/.test(sql)) return { rows: [] };
      throw new Error(`Consulta no prevista: ${sql}`);
    });
  }

  function esperarSinEscritura() {
    expect(pool.connect).not.toHaveBeenCalled();
    expect(cliente.query).not.toHaveBeenCalled();
    expect(cliente.release).not.toHaveBeenCalled();
    expect(archivos.size).toBe(1); // La foto válida sí atravesó Multer; afterEach la limpia.
  }

  function esperarAlta(res) {
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      message: 'Reporte guardado correctamente', id: 321, imagen: expect.any(String),
      imageUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/uploads\//),
    });
    expect(res.body.imageUrl.endsWith('/' + res.body.imagen)).toBe(true);
    expect(cliente.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO historial'),
      [321, 'perdido', expect.any(Number), 'usuario']);
    expect(cliente.query).toHaveBeenCalledWith('COMMIT');
    expect(cliente.release).toHaveBeenCalledTimes(1);
    return cliente.query.mock.calls.find(([sql]) => /INSERT INTO reportes/.test(sql))[1];
  }

  const limites = [['titulo', 255, 2], ['contacto', 255, 8], ['ubicacion_otro', 255, 7],
    ['campus', 50, 5]];
  const alfabetos = [['ASCII', 'x'], ['acentuado', 'á'], ['suplementario', '😀']];
  test.each(limites.flatMap(([campo, maximo]) => alfabetos.map(([nombre, caracter]) =>
    [campo, maximo, nombre, caracter])))('%s >%i (%s) → 400 sin escritura', async (campo, maximo, _, caracter) => {
    simularCatalogos();
    const res = await alta(conCampo(campo, `  ${caracter.repeat(maximo + 1)}  `));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: expect.stringMatching(new RegExp(`${campo}.*${maximo}`)) });
    esperarSinEscritura();
    expect(pool.query).not.toHaveBeenCalled();
  });

  test.each(limites.flatMap(([campo, maximo, indice]) => alfabetos.map(([nombre, caracter]) =>
    [campo, maximo, nombre, caracter, indice])))('%s =%i (%s) → 201 sin truncar', async (campo, maximo, _, caracter, indice) => {
    simularCatalogos();
    const texto = caracter.repeat(maximo);
    const valores = esperarAlta(await alta(conCampo(campo, `  ${texto}  `)));
    expect(valores[indice]).toBe(texto);
    expect([...valores[indice]]).toHaveLength(maximo);
  });

  test.each([
    ['aceptado', 'e\u0301'.repeat(127) + 'e', 201],
    ['excedido', 'e\u0301'.repeat(128), 400],
  ])('Unicode combinante %s cuenta puntos de código, no grafemas', async (_, texto, status) => {
    const res = await alta(conCampo('titulo', texto));
    expect(res.status).toBe(status);
    if (status === 201) expect(esperarAlta(res)[2]).toBe(texto);
    else {
      expect(res.body).toEqual({ message: expect.stringMatching(/titulo.*255/) });
      expect(pool.query).not.toHaveBeenCalled();
      esperarSinEscritura();
    }
  });

  const camposId = ['categoria_id', 'ubicacion_id'];
  test.each(camposId.flatMap((campo) => ['0', '-2147483649', '2147483648', '9007199254740992']
    .map((valor) => [campo, valor])))('%s=%s → 400 antes de consultar BD', async (campo, valor) => {
    const res = await alta(conCampo(campo, valor));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: expect.stringMatching(new RegExp(`${campo}.*entero positivo`)) });
    expect(pool.query).not.toHaveBeenCalled();
    esperarSinEscritura();
  });

  test.each(camposId.flatMap((campo) => ['1', '2147483647'].map((valor) => [campo, valor])))(
    '%s=%s → 201 en los extremos admitidos', async (campo, valor) => {
      simularCatalogos();
      const valores = esperarAlta(await alta(conCampo(campo, valor)));
      const indice = { categoria_id: 4, ubicacion_id: 6 }[campo];
      expect(valores[indice]).toBe(Number(valor));
      const tabla = { categoria_id: 'categorias', ubicacion_id: 'ubicaciones' }[campo];
      expect(pool.query).toHaveBeenCalledWith(expect.stringContaining(`SELECT id FROM ${tabla}`),
        campo === 'ubicacion_id' ? [Number(valor), 'principal'] : [Number(valor)]);
      expect(cliente.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO historial'),
        [321, 'perdido', 42, 'usuario']);
      if (campo === 'ubicacion_id') expect(valores[7]).toBeNull();
    });

  test.each(['1', '2147483647', '2147483648'].flatMap((valor) => [true, false].map((conUsuario) =>
    [valor, conUsuario])))('administrador_id=%s, usuario presente=%s → siempre 400', async (valor, conUsuario) => {
    const datos = { ...datosValidos, administrador_id: valor };
    if (!conUsuario) delete datos.usuario_id;
    const res = await alta(datos);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Campo retirado del alta: administrador_id' });
    expect(pool.query).not.toHaveBeenCalled();
    esperarSinEscritura();
  });
});

describe('Multer: MIME y extensión exactos; campo image y límite existentes', () => {
  test.each([
    ['foto.jpg', 'image/jpeg'], ['foto.jpeg', 'image/jpeg'], ['foto.jpg', 'image/jpg'],
    ['foto.png', 'image/png'], ['foto.PNG', 'image/png'],
  ])('%s (%s) conserva 201 y sobre existente', async (nombre, mime) => {
    const res = await alta(datosValidos, { nombre, mime });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      message: 'Reporte guardado correctamente', id: 321,
      imagen: expect.any(String), imageUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/uploads\//),
    });
    expect(res.body.imageUrl.endsWith('/' + res.body.imagen)).toBe(true);
    expect([...archivos].some((ruta) => ruta.endsWith(res.body.imagen))).toBe(true);
    expect(cliente.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO reportes'),
      expect.arrayContaining([res.body.imagen, 'principal', 'perdido']));
    expect(cliente.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO historial'), [321, 'perdido', 42, 'usuario']);
    expect(cliente.query).toHaveBeenCalledWith('COMMIT');
    expect(cliente.release).toHaveBeenCalledTimes(1);
  });

  test('estado inicial legado sigue tolerado sin ser fuente de autor', async () => {
    const datos = { ...datosValidos, estado: 'encontrado' };
    delete datos.tipo_reporte;
    const res = await alta(datos);
    expect(res.status).toBe(201);
    expect(cliente.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO historial'), [321, 'encontrado', 42, 'usuario']);
  });

  test.each([
    ['foto.gif', 'image/gif'], ['foto.webp', 'image/webp'], ['texto.txt', 'text/plain'],
    ['foto.png', 'text/plain'], ['foto.txt', 'image/png'],
    ['foto.png.exe', 'image/png'], ['foto.notpng', 'image/png'],
    ['foto.png', 'application/png'], ['foto.png', 'image/pngmalicioso'],
    ['foto.jpeg', 'application/jpeg'],
  ])('%s (%s) → 400 sin persistencia', async (nombre, mime) => {
    const res = await alta(datosValidos, { nombre, mime });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: expect.stringMatching(/JPG.*JPEG.*PNG/i) });
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(archivos.size).toBe(0);
  });

  test('más de 5 MB → 400 de Multer sin persistencia', async () => {
    const res = await alta(datosValidos, { nombre: 'grande.png', mime: 'image/png', contenido: Buffer.alloc(5 * 1024 * 1024 + 1) });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Error al subir la imagen');
    expect(pool.connect).not.toHaveBeenCalled();
    expect(upload.limits.fileSize).toBe(5 * 1024 * 1024);
  });

  test('campo de archivo distinto de image → 400', async () => {
    const res = await alta(datosValidos, { nombre: 'foto.png', mime: 'image/png' }, 'foto');
    expect(res.status).toBe(400);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('T7: rutas administrativas deshabilitadas', () => {
  test.each(['status', 'active'].flatMap((ruta) => ['123', 'no-entero'].flatMap((id) => [undefined, {}, { estado: 'devuelto', activo: true, administrador_id: 1 }, { status: 'entregado', is_active: 'incorrecto' }].map((cuerpo) => [ruta, id, cuerpo]))))('%s/%s con %j → 403 uniforme sin servicios ni BD', async (ruta, id, cuerpo) => {
    const spies = Object.keys(servicio).filter((clave) => typeof servicio[clave] === 'function').map((clave) => jest.spyOn(servicio, clave));
    let solicitud = request(app).put(`/reportes/${id}/${ruta}`);
    if (cuerpo !== undefined) solicitud = solicitud.send(cuerpo);
    const res = await solicitud;
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ message: 'Operación administrativa no habilitada' });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test.each(['actualizarEstado', 'actualizarActivo'])('%s no lee cuerpo ni parámetros', (nombre) => {
    const controlador = require('../controllers/reportController');
    const req = {};
    for (const clave of ['body', 'params']) Object.defineProperty(req, clave, { get() { throw new Error(`No leer ${clave}`); } });
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    controlador[nombre](req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: 'Operación administrativa no habilitada' });
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('Traducción HTTP de errores', () => {
  test.each([400, 403, 404, 500])('status %i conserva message del servicio', async (status) => {
    jest.spyOn(servicio, 'crearReporte').mockRejectedValue(Object.assign(new Error('Fallo de prueba'), { status }));
    const res = await alta();
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ message: 'Fallo de prueba' });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('error no clasificado → 500', async () => {
    jest.spyOn(servicio, 'crearReporte').mockRejectedValue(new Error('Fallo no clasificado'));
    const res = await alta();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: 'Fallo no clasificado' });
  });

  test('GET /reportes/no-numerico → 404 sin consultar BD', async () => {
    const res = await request(app).get('/reportes/no-numerico');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Reporte no encontrado' });
    expect(pool.query).not.toHaveBeenCalled();
  });
});
