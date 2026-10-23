jest.mock('../config/database', () => ({ query: jest.fn() }));

const request = require('supertest');
const authService = require('../services/authService');
const userService = require('../services/userService');
const reportService = require('../services/reportService');
const pool = require('../config/database');
const app = require('../app');

const {
  crearServicioAutenticacion,
  normalizarCorreo,
  perteneceAlDominioInstitucional,
  validarClaimsGoogle,
} = authService;
const { crearResolutorCuentaEstudiantil } = require('../services/userService');
const jwt = require('jsonwebtoken');
const express = require('express');
const errorHandler = require('../middleware/errorHandler');
const {
  autenticar,
  bloquearRutaNoEstudiantil,
  crearAutenticador,
  extraerTokenBearer,
} = require('../middleware/authMiddleware');

const configuracionGoogle = Object.freeze({
  audiencias: Object.freeze(['cliente-web-findu', 'cliente-android-findu']),
  dominioInstitucional: 'estudiantes.universidad.example',
});

function crearTicket(payload) {
  return { getPayload: jest.fn(() => payload) };
}

function crearDependencias(payload = {}) {
  const clienteGoogle = {
    verifyIdToken: jest.fn().mockResolvedValue(
      crearTicket({
        email: ' Estudiante@Estudiantes.Universidad.Example ',
        email_verified: true,
        name: ' Estudiante Verificado ',
        picture: 'https://example.test/foto.jpg',
        ...payload,
      }),
    ),
  };
  const resolverUsuario = jest.fn(async () => ({ id: 1 }));
  const emitirJwt = jest.fn(async () => 'jwt-de-prueba');
  const continuarAutenticacion = jest.fn(async (identidad) => {
    await resolverUsuario(identidad);
    await emitirJwt({ id: 1 });
    return identidad;
  });
  const servicio = crearServicioAutenticacion({
    clienteGoogle,
    obtenerConfiguracionGoogle: () => configuracionGoogle,
    continuarAutenticacion,
  });

  return {
    clienteGoogle,
    continuarAutenticacion,
    emitirJwt,
    resolverUsuario,
    servicio,
  };
}

async function esperarError401(promesa, mensajesProhibidos = []) {
  let errorRecibido;
  try {
    await promesa;
  } catch (error) {
    errorRecibido = error;
  }

  expect(errorRecibido).toBeInstanceOf(Error);
  expect(errorRecibido.status).toBe(401);
  expect(errorRecibido.message).toBe(
    'No fue posible verificar la identidad institucional',
  );
  for (const mensaje of mensajesProhibidos) {
    expect(errorRecibido.message).not.toContain(mensaje);
  }
}

describe('helpers puros de identidad Google', () => {
  test('normaliza el correo con trim y minúsculas', () => {
    expect(normalizarCorreo(' Alumno@Universidad.Example ')).toBe(
      'alumno@universidad.example',
    );
  });

  test.each([
    ['alumno@estudiantes.universidad.example', true],
    ['ALUMNO@ESTUDIANTES.UNIVERSIDAD.EXAMPLE', true],
    ['alumno@otro.example', false],
    ['alumno@estudiantes.universidad.example.atacante.test', false],
    ['alumno@falsoestudiantes.universidad.example', false],
    ['alumno@sub.estudiantes.universidad.example', false],
  ])('compara el dominio completo de %s sin aceptar sufijos (%s)', (correo, esperado) => {
    expect(
      perteneceAlDominioInstitucional(
        correo,
        configuracionGoogle.dominioInstitucional,
      ),
    ).toBe(esperado);
  });

  test('valida claims y devuelve solo la identidad verificable normalizada', () => {
    expect(
      validarClaimsGoogle(
        {
          email: ' Alumno@Estudiantes.Universidad.Example ',
          email_verified: true,
          name: ' Alumno Verificado ',
          picture: 'https://example.test/foto.jpg',
          sub: 'claim-sensible-no-propagado',
        },
        configuracionGoogle.dominioInstitucional,
      ),
    ).toEqual({
      correo: 'alumno@estudiantes.universidad.example',
      nombre: 'Alumno Verificado',
      foto: 'https://example.test/foto.jpg',
    });
  });
});

describe('verificación del ID token de Google', () => {
  test('delega firma, emisor, audiencia y vigencia en google-auth-library', async () => {
    const {
      clienteGoogle,
      continuarAutenticacion,
      emitirJwt,
      resolverUsuario,
      servicio,
    } = crearDependencias();

    await expect(servicio.autenticarConGoogle('id-token-de-prueba')).resolves.toEqual({
      correo: 'estudiante@estudiantes.universidad.example',
      nombre: 'Estudiante Verificado',
      foto: 'https://example.test/foto.jpg',
    });
    expect(clienteGoogle.verifyIdToken).toHaveBeenCalledWith({
      idToken: 'id-token-de-prueba',
      audience: configuracionGoogle.audiencias,
    });
    expect(continuarAutenticacion).toHaveBeenCalledWith({
      correo: 'estudiante@estudiantes.universidad.example',
      nombre: 'Estudiante Verificado',
      foto: 'https://example.test/foto.jpg',
    });
    expect(resolverUsuario).toHaveBeenCalledTimes(1);
    expect(emitirJwt).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['firma inválida', 'invalid signature: token crudo abc.def.ghi'],
    ['emisor ajeno', 'Wrong issuer https://atacante.test'],
    ['audiencia ajena', 'Wrong recipient cliente-de-tercero'],
    ['token vencido', 'Token used too late, exp=123456'],
  ])('traduce el rechazo de %s sin filtrar el error crudo', async (_caso, detalleGoogle) => {
    const {
      clienteGoogle,
      continuarAutenticacion,
      emitirJwt,
      resolverUsuario,
      servicio,
    } = crearDependencias();
    clienteGoogle.verifyIdToken.mockRejectedValueOnce(new Error(detalleGoogle));

    await esperarError401(
      servicio.autenticarConGoogle('token-sensible'),
      [detalleGoogle, 'token-sensible'],
    );
    expect(continuarAutenticacion).not.toHaveBeenCalled();
    expect(resolverUsuario).not.toHaveBeenCalled();
    expect(emitirJwt).not.toHaveBeenCalled();
  });

  test('rechaza un ID token ausente antes de invocar Google o colaboradores posteriores', async () => {
    const {
      clienteGoogle,
      continuarAutenticacion,
      emitirJwt,
      resolverUsuario,
      servicio,
    } = crearDependencias();

    await esperarError401(servicio.autenticarConGoogle('   '));
    expect(clienteGoogle.verifyIdToken).not.toHaveBeenCalled();
    expect(continuarAutenticacion).not.toHaveBeenCalled();
    expect(resolverUsuario).not.toHaveBeenCalled();
    expect(emitirJwt).not.toHaveBeenCalled();
  });

  test.each([
    [{ email_verified: false }, 'correo no verificado'],
    [{ email: 'alumno@otro.example' }, 'dominio ajeno'],
    [
      { email: 'alumno@estudiantes.universidad.example.atacante.test' },
      'dominio con sufijo engañoso',
    ],
    [{ name: '   ' }, 'nombre vacío'],
    [{ name: undefined }, 'nombre ausente'],
  ])('rechaza claims con %s (%s) sin continuar hacia persistencia o emisión', async (payload) => {
    const {
      continuarAutenticacion,
      emitirJwt,
      resolverUsuario,
      servicio,
    } = crearDependencias(payload);

    await esperarError401(servicio.autenticarConGoogle('id-token-de-prueba'));
    expect(continuarAutenticacion).not.toHaveBeenCalled();
    expect(resolverUsuario).not.toHaveBeenCalled();
    expect(emitirJwt).not.toHaveBeenCalled();
  });
});

describe('resolución de la cuenta estudiantil', () => {
  test('reutiliza la cuenta activa por correo normalizado sin sobrescribir nombre ni foto', async () => {
    const cuentaAlmacenada = {
      id: 17,
      nombre: 'Nombre almacenado',
      correo: 'Estudiante@Estudiantes.Universidad.Example',
      foto: 'foto-almacenada.jpg',
      activo: true,
    };
    const pool = {
      query: jest.fn().mockResolvedValueOnce({ rows: [cuentaAlmacenada] }),
    };
    const resolver = crearResolutorCuentaEstudiantil({ pool });

    await expect(
      resolver({
        correo: 'estudiante@estudiantes.universidad.example',
        nombre: 'Nombre nuevo de Google',
        foto: 'foto-nueva.jpg',
      }),
    ).resolves.toBe(cuentaAlmacenada);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('LOWER(correo) = LOWER($1)'),
      ['estudiante@estudiantes.universidad.example'],
    );
    expect(pool.query.mock.calls[0][0]).toContain('ORDER BY id ASC');
  });

  test('rechaza con 401 una cuenta existente inactiva sin intentar modificarla', async () => {
    const pool = {
      query: jest.fn().mockResolvedValueOnce({
        rows: [{ id: 18, nombre: 'Cuenta inactiva', activo: false }],
      }),
    };
    const resolver = crearResolutorCuentaEstudiantil({ pool });

    await expect(
      resolver({
        correo: 'inactivo@estudiantes.universidad.example',
        nombre: 'Nombre de Google',
        foto: null,
      }),
    ).rejects.toMatchObject({
      status: 401,
      message: 'La cuenta institucional no está activa',
    });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('crea una cuenta activa con ON CONFLICT y la relee antes de devolverla', async () => {
    const cuentaCreada = {
      id: 19,
      nombre: 'Nueva estudiante',
      correo: 'nueva@estudiantes.universidad.example',
      foto: null,
      activo: true,
    };
    const pool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 19 }] })
        .mockResolvedValueOnce({ rows: [cuentaCreada] }),
    };
    const resolver = crearResolutorCuentaEstudiantil({ pool });

    await expect(
      resolver({
        correo: 'NUEVA@ESTUDIANTES.UNIVERSIDAD.EXAMPLE',
        nombre: 'Nueva estudiante',
        foto: null,
      }),
    ).resolves.toEqual(cuentaCreada);

    expect(pool.query.mock.calls[1][0]).toContain(
      'ON CONFLICT (correo) DO NOTHING',
    );
    expect(pool.query.mock.calls[1][0]).toContain(
      'INSERT INTO usuarios (nombre, correo, foto, activo)',
    );
    expect(pool.query.mock.calls[1][1]).toEqual([
      'Nueva estudiante',
      'nueva@estudiantes.universidad.example',
      null,
    ]);
    expect(pool.query.mock.calls[2][0]).toContain(
      'LOWER(correo) = LOWER($1)',
    );
  });

  test('tras un conflicto concurrente relee y reutiliza la única cuenta creada', async () => {
    const cuentaGanadora = {
      id: 20,
      nombre: 'Nombre del intento ganador',
      correo: 'carrera@estudiantes.universidad.example',
      foto: 'ganadora.jpg',
      activo: true,
    };
    const pool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [cuentaGanadora] }),
    };
    const resolver = crearResolutorCuentaEstudiantil({ pool });

    await expect(
      resolver({
        correo: 'carrera@estudiantes.universidad.example',
        nombre: 'Nombre del intento perdedor',
        foto: 'perdedora.jpg',
      }),
    ).resolves.toBe(cuentaGanadora);
    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  test('traduce a 401 la imposibilidad normativa de resolver tras la carrera', async () => {
    const pool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    const resolver = crearResolutorCuentaEstudiantil({ pool });

    await expect(
      resolver({
        correo: 'carrera@estudiantes.universidad.example',
        nombre: 'Estudiante',
        foto: null,
      }),
    ).rejects.toMatchObject({
      status: 401,
      message: 'No fue posible resolver la cuenta institucional',
    });
  });

  test('propaga los errores reales de base de datos sin convertirlos en 401', async () => {
    const errorBd = new Error('conexión rechazada');
    const pool = { query: jest.fn().mockRejectedValueOnce(errorBd) };
    const resolver = crearResolutorCuentaEstudiantil({ pool });

    await expect(
      resolver({
        correo: 'alumno@estudiantes.universidad.example',
        nombre: 'Alumno',
        foto: null,
      }),
    ).rejects.toBe(errorBd);
    expect(errorBd.status).toBeUndefined();
  });
});

describe('emisión de la sesión JWT de FindU', () => {
  test('emite HS256 con identidad mínima y expiración configurable desde el reloj', async () => {
    const ahora = Date.UTC(2026, 9, 22, 12, 0, 0);
    const secreto = 'secreto-jwt-de-prueba-suficientemente-largo';
    const usuario = {
      id: 42,
      nombre: 'Estudiante almacenada',
      correo: 'estudiante@estudiantes.universidad.example',
      foto: 'foto-almacenada.jpg',
      activo: true,
    };
    const resolverCuentaEstudiantil = jest.fn().mockResolvedValue(usuario);
    const clienteGoogle = {
      verifyIdToken: jest.fn().mockResolvedValue(
        crearTicket({
          email: 'ESTUDIANTE@ESTUDIANTES.UNIVERSIDAD.EXAMPLE',
          email_verified: true,
          name: 'Nombre de Google que no sobrescribe',
          picture: 'foto-google.jpg',
        }),
      ),
    };
    const servicio = crearServicioAutenticacion({
      clienteGoogle,
      obtenerConfiguracionGoogle: () => configuracionGoogle,
      resolverCuentaEstudiantil,
      obtenerConfiguracionJwt: () => ({
        secret: secreto,
        expiracionHoras: 12,
        emisor: 'FindU',
      }),
      reloj: () => ahora,
    });

    const sesion = await servicio.autenticarConGoogle('id-token-valido');
    const completo = jwt.decode(sesion.token, { complete: true });
    const payloadVerificado = jwt.verify(sesion.token, secreto, {
      algorithms: ['HS256'],
      issuer: 'FindU',
      clockTimestamp: Math.floor(ahora / 1000),
    });

    expect(resolverCuentaEstudiantil).toHaveBeenCalledWith({
      correo: 'estudiante@estudiantes.universidad.example',
      nombre: 'Nombre de Google que no sobrescribe',
      foto: 'foto-google.jpg',
    });
    expect(completo.header.alg).toBe('HS256');
    expect(payloadVerificado).toEqual({
      sub: '42',
      ambito: 'estudiante',
      iat: Math.floor(ahora / 1000),
      exp: Math.floor(ahora / 1000) + 12 * 60 * 60,
      iss: 'FindU',
    });
    expect(sesion).toEqual({
      token: expect.any(String),
      expiraEn: ahora + 12 * 60 * 60 * 1000,
      usuario: {
        id: 42,
        nombre: 'Estudiante almacenada',
        correo: 'estudiante@estudiantes.universidad.example',
        foto: 'foto-almacenada.jpg',
      },
    });
    expect(sesion).not.toHaveProperty('refreshToken');
    expect(payloadVerificado).not.toHaveProperty('correo');
    expect(payloadVerificado).not.toHaveProperty('nombre');
    expect(payloadVerificado).not.toHaveProperty('foto');
    expect(payloadVerificado).not.toHaveProperty('rol');
  });

  test('usa 24 horas cuando esa es la expiración cargada', async () => {
    const ahora = Date.UTC(2026, 9, 22, 0, 0, 0);
    const servicio = crearServicioAutenticacion({
      clienteGoogle: {
        verifyIdToken: jest.fn().mockResolvedValue(
          crearTicket({
            email: 'alumno@estudiantes.universidad.example',
            email_verified: true,
            name: 'Alumno',
          }),
        ),
      },
      obtenerConfiguracionGoogle: () => configuracionGoogle,
      resolverCuentaEstudiantil: jest.fn().mockResolvedValue({
        id: 7,
        nombre: 'Alumno',
        correo: 'alumno@estudiantes.universidad.example',
        foto: null,
        activo: true,
      }),
      obtenerConfiguracionJwt: () => ({
        secret: 'otro-secreto-de-prueba',
        expiracionHoras: 24,
        emisor: 'FindU',
      }),
      reloj: () => ahora,
    });

    const sesion = await servicio.autenticarConGoogle('id-token-valido');
    expect(sesion.expiraEn).toBe(ahora + 24 * 60 * 60 * 1000);
  });
});

describe('POST /usuarios/iniciar-sesion-google', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('acepta idToken como única identidad y devuelve el contrato exacto de sesión', async () => {
    const sesion = {
      token: 'jwt-findu',
      expiraEn: 1792756800000,
      usuario: {
        id: 42,
        nombre: 'Estudiante almacenada',
        correo: 'estudiante@estudiantes.universidad.example',
        foto: 'foto-almacenada.jpg',
      },
    };
    const autenticar = jest
      .spyOn(authService, 'autenticarConGoogle')
      .mockResolvedValue(sesion);

    const respuesta = await request(app)
      .post('/usuarios/iniciar-sesion-google')
      .send({
        idToken: 'id-token-valido',
        email: 'identidad-no-confiable@atacante.test',
        name: 'Nombre no confiable',
        picture: 'foto-no-confiable.jpg',
      });

    expect(respuesta.status).toBe(200);
    expect(respuesta.body).toEqual(sesion);
    expect(autenticar).toHaveBeenCalledTimes(1);
    expect(autenticar).toHaveBeenCalledWith('id-token-valido');
  });

  test.each([
    ['cuerpo ausente', undefined],
    ['token nulo', null],
    ['token vacío', ''],
    ['token con espacios', '   '],
    ['token no textual', 123],
  ])('rechaza con 401 un %s sin invocar el servicio', async (_caso, idToken) => {
    const autenticar = jest.spyOn(authService, 'autenticarConGoogle');
    const cuerpo = idToken === undefined ? {} : { idToken };

    const respuesta = await request(app)
      .post('/usuarios/iniciar-sesion-google')
      .send(cuerpo);

    expect(respuesta.status).toBe(401);
    expect(respuesta.body).toEqual({
      message: 'No fue posible verificar la identidad institucional',
    });
    expect(autenticar).not.toHaveBeenCalled();
  });

  test.each([
    'token inválido',
    'token vencido',
    'otra audiencia',
    'correo no verificado',
    'dominio ajeno',
    'nombre ausente',
  ])('traduce a 401 comprensible el caso %s sin filtrar detalles', async () => {
    const error = Object.assign(
      new Error('detalle interno de Google: token-sensible'),
      { status: 401 },
    );
    jest.spyOn(authService, 'autenticarConGoogle').mockRejectedValue(error);

    const respuesta = await request(app)
      .post('/usuarios/iniciar-sesion-google')
      .send({ idToken: 'token-sensible' });

    expect(respuesta.status).toBe(401);
    expect(respuesta.body).toEqual({
      message: 'No fue posible verificar la identidad institucional',
    });
    expect(JSON.stringify(respuesta.body)).not.toContain('token-sensible');
    expect(JSON.stringify(respuesta.body)).not.toContain('detalle interno');
  });

  test('mantiene un mensaje comprensible para una cuenta inactiva', async () => {
    const error = Object.assign(
      new Error('La cuenta institucional no está activa'),
      { status: 401 },
    );
    jest.spyOn(authService, 'autenticarConGoogle').mockRejectedValue(error);

    const respuesta = await request(app)
      .post('/usuarios/iniciar-sesion-google')
      .send({ idToken: 'id-token-valido' });

    expect(respuesta.status).toBe(401);
    expect(respuesta.body).toEqual({
      message: 'La cuenta institucional no está activa',
    });
  });
});

describe('POST /usuarios/google-login retirado', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('responde 404 sin procesar identidad del cuerpo ni invocar servicios', async () => {
    const autenticar = jest.spyOn(authService, 'autenticarConGoogle');
    const loginLegacy = jest.spyOn(userService, 'loginGoogle');
    const buscarPorCorreo = jest.spyOn(userService, 'buscarPorCorreo');
    const crearUsuario = jest.spyOn(userService, 'crearUsuario');

    const respuesta = await request(app)
      .post('/usuarios/google-login')
      .send({
        email: 'victima@estudiantes.universidad.example',
        name: 'Identidad no verificada',
        picture: 'foto-no-verificada.jpg',
      });

    expect(respuesta.status).toBe(404);
    expect(autenticar).not.toHaveBeenCalled();
    expect(loginLegacy).not.toHaveBeenCalled();
    expect(buscarPorCorreo).not.toHaveBeenCalled();
    expect(crearUsuario).not.toHaveBeenCalled();
  });
});

describe('middleware de autenticación estudiantil', () => {
  const secreto = 'secreto-de-prueba-para-middleware';
  const configuracionJwt = Object.freeze({
    secret: secreto,
    emisor: 'FindU',
  });
  let errorEnConsola;

  function crearAppMiddleware({
    obtenerUsuarioPorId = jest.fn().mockResolvedValue({
      id: 42,
      nombre: 'Estudiante activa',
      correo: 'activa@estudiantes.universidad.example',
      foto: 'foto.jpg',
      activo: true,
      contrasena: 'no-debe-exponerse',
      rol: 'no-existe-para-estudiantes',
      fecha_creacion: '2026-10-22 10:00',
    }),
    verificarJwt = jwt.verify,
  } = {}) {
    const appMiddleware = express();
    const middleware = crearAutenticador({
      obtenerConfiguracionJwt: () => configuracionJwt,
      obtenerUsuarioPorId,
      verificarJwt,
    });
    appMiddleware.get('/protegida', middleware, (req, res) => {
      res.json({ usuario: req.usuario });
    });
    appMiddleware.use(errorHandler);
    return { appMiddleware, obtenerUsuarioPorId };
  }

  function firmarToken(payload = {}, opciones = {}) {
    return jwt.sign(
      { sub: '42', ambito: 'estudiante', ...payload },
      opciones.secret || secreto,
      {
        algorithm: opciones.algorithm || 'HS256',
        issuer: opciones.issuer || 'FindU',
        expiresIn: opciones.expiresIn || '1h',
      },
    );
  }

  beforeEach(() => {
    errorEnConsola = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorEnConsola.mockRestore();
  });

  test.each([
    ['sin cabecera', undefined],
    ['esquema Basic', 'Basic credenciales'],
    ['esquema bearer no canónico', 'bearer token'],
    ['Bearer sin token', 'Bearer'],
    ['token vacío', 'Bearer   '],
    ['dos tokens separados por espacio', 'Bearer token otro'],
    ['dos valores ambiguos', 'Bearer token, Bearer otro'],
  ])('responde 401 con %s sin consultar la cuenta', async (_caso, authorization) => {
    const { appMiddleware, obtenerUsuarioPorId } = crearAppMiddleware();
    const solicitud = request(appMiddleware).get('/protegida');
    if (authorization !== undefined) solicitud.set('Authorization', authorization);

    const respuesta = await solicitud;

    expect(respuesta.status).toBe(401);
    expect(respuesta.body).toEqual({ message: 'Autenticación requerida' });
    expect(obtenerUsuarioPorId).not.toHaveBeenCalled();
  });

  test('rechaza cabeceras Authorization repetidas aunque Node exponga un solo valor', () => {
    expect(
      extraerTokenBearer({
        headers: { authorization: 'Bearer primer-token' },
        rawHeaders: [
          'Authorization',
          'Bearer primer-token',
          'Authorization',
          'Bearer segundo-token',
        ],
      }),
    ).toBeNull();
  });

  test.each([
    ['firma inválida', () => firmarToken({}, { secret: 'otro-secreto' })],
    ['algoritmo distinto', () => firmarToken({}, { algorithm: 'HS384' })],
    ['emisor distinto', () => firmarToken({}, { issuer: 'OtroSistema' })],
    ['token vencido', () => firmarToken({}, { expiresIn: -1 })],
    ['token malformado', () => 'no-es-un-jwt'],
  ])('responde 401 ante %s sin consultar la cuenta', async (_caso, crearToken) => {
    const { appMiddleware, obtenerUsuarioPorId } = crearAppMiddleware();

    const respuesta = await request(appMiddleware)
      .get('/protegida')
      .set('Authorization', `Bearer ${crearToken()}`);

    expect(respuesta.status).toBe(401);
    expect(respuesta.body).toEqual({ message: 'Sesión inválida o expirada' });
    expect(obtenerUsuarioPorId).not.toHaveBeenCalled();
  });

  test('verifica con el secreto, HS256 y emisor configurados de forma explícita', async () => {
    const verificarJwt = jest.fn().mockReturnValue({
      sub: '42',
      ambito: 'estudiante',
    });
    const { appMiddleware } = crearAppMiddleware({ verificarJwt });

    const respuesta = await request(appMiddleware)
      .get('/protegida')
      .set('Authorization', 'Bearer jwt-de-prueba');

    expect(respuesta.status).toBe(200);
    expect(verificarJwt).toHaveBeenCalledWith('jwt-de-prueba', secreto, {
      algorithms: ['HS256'],
      issuer: 'FindU',
    });
  });

  test.each([
    ['sub ausente', { sub: undefined, ambito: 'estudiante' }],
    ['sub cero', { sub: '0', ambito: 'estudiante' }],
    ['sub negativo', { sub: '-1', ambito: 'estudiante' }],
    ['sub decimal', { sub: '1.5', ambito: 'estudiante' }],
    ['sub con formato ambiguo', { sub: '042', ambito: 'estudiante' }],
    ['sub fuera de INTEGER', { sub: '2147483648', ambito: 'estudiante' }],
    ['ámbito ausente', { sub: '42', ambito: undefined }],
    ['ámbito no estudiantil', { sub: '42', ambito: 'administrador' }],
  ])('rechaza claims inválidos: %s', async (_caso, payload) => {
    const verificarJwt = jest.fn().mockReturnValue(payload);
    const { appMiddleware, obtenerUsuarioPorId } = crearAppMiddleware({
      verificarJwt,
    });

    const respuesta = await request(appMiddleware)
      .get('/protegida')
      .set('Authorization', 'Bearer jwt-de-prueba');

    expect(respuesta.status).toBe(401);
    expect(respuesta.body).toEqual({ message: 'Sesión inválida o expirada' });
    expect(obtenerUsuarioPorId).not.toHaveBeenCalled();
  });

  test.each([
    ['cuenta inexistente', null],
    ['cuenta inactiva', { id: 42, activo: false }],
    ['actividad no booleana', { id: 42, activo: 1 }],
  ])('responde 401 ante %s', async (_caso, usuario) => {
    const obtenerUsuarioPorId = jest.fn().mockResolvedValue(usuario);
    const { appMiddleware } = crearAppMiddleware({ obtenerUsuarioPorId });

    const respuesta = await request(appMiddleware)
      .get('/protegida')
      .set('Authorization', `Bearer ${firmarToken()}`);

    expect(respuesta.status).toBe(401);
    expect(respuesta.body).toEqual({ message: 'Sesión inválida o expirada' });
    expect(obtenerUsuarioPorId).toHaveBeenCalledWith(42);
  });

  test('propaga un error de BD al error handler como 500 y no como 401', async () => {
    const errorBd = new Error('conexión de prueba rechazada');
    const obtenerUsuarioPorId = jest.fn().mockRejectedValue(errorBd);
    const { appMiddleware } = crearAppMiddleware({ obtenerUsuarioPorId });

    const respuesta = await request(appMiddleware)
      .get('/protegida')
      .set('Authorization', `Bearer ${firmarToken()}`);

    expect(respuesta.status).toBe(500);
    expect(respuesta.body).toEqual({ message: 'conexión de prueba rechazada' });
    expect(errorBd.status).toBeUndefined();
  });

  test('adjunta únicamente el perfil mínimo de la cuenta activa', async () => {
    const { appMiddleware, obtenerUsuarioPorId } = crearAppMiddleware();

    const respuesta = await request(appMiddleware)
      .get('/protegida')
      .set('Authorization', `Bearer ${firmarToken()}`);

    expect(respuesta.status).toBe(200);
    expect(obtenerUsuarioPorId).toHaveBeenCalledWith(42);
    expect(respuesta.body).toEqual({
      usuario: {
        id: 42,
        nombre: 'Estudiante activa',
        correo: 'activa@estudiantes.universidad.example',
        foto: 'foto.jpg',
      },
    });
  });

  test('acepta el límite superior de INTEGER como sub válido', async () => {
    const obtenerUsuarioPorId = jest.fn().mockResolvedValue({
      id: 2147483647,
      nombre: 'Estudiante límite',
      correo: 'limite@estudiantes.universidad.example',
      foto: null,
      activo: true,
    });
    const verificarJwt = jest.fn().mockReturnValue({
      sub: '2147483647',
      ambito: 'estudiante',
    });
    const { appMiddleware } = crearAppMiddleware({
      obtenerUsuarioPorId,
      verificarJwt,
    });

    const respuesta = await request(appMiddleware)
      .get('/protegida')
      .set('Authorization', 'Bearer jwt-de-prueba');

    expect(respuesta.status).toBe(200);
    expect(obtenerUsuarioPorId).toHaveBeenCalledWith(2147483647);
  });

  test('el export por defecto usa la frontera vigente del servicio de usuarios', () => {
    expect(autenticar).toEqual(expect.any(Function));
  });
});

describe('guard de rutas no estudiantiles', () => {
  test('responde 403 uniforme y no ejecuta el siguiente manejador', async () => {
    const siguiente = jest.fn((_req, res) => res.status(204).end());
    const appGuard = express();
    appGuard.all('/no-habilitada', bloquearRutaNoEstudiantil, siguiente);

    const respuesta = await request(appGuard)
      .post('/no-habilitada')
      .send({ rol: 'administrador' });

    expect(respuesta.status).toBe(403);
    expect(respuesta.body).toEqual({
      message: 'Operación administrativa no habilitada',
    });
    expect(siguiente).not.toHaveBeenCalled();
  });
});

describe('rutas de usuarios protegidas y perfil propio', () => {
  const secretoAnterior = process.env.JWT_SECRET;
  const secreto = 'secreto-de-prueba-para-rutas-de-usuarios';

  function firmarTokenUsuario(id = 42) {
    return jwt.sign(
      { sub: String(id), ambito: 'estudiante' },
      secreto,
      { algorithm: 'HS256', issuer: 'FindU', expiresIn: '1h' },
    );
  }

  function cuentaActiva(id = 42) {
    return {
      id,
      nombre: 'Estudiante activa',
      correo: 'activa@estudiantes.universidad.example',
      foto: 'foto.jpg',
      activo: true,
      fecha_creacion: '2026-10-22 10:00',
    };
  }

  beforeAll(() => {
    process.env.JWT_SECRET = secreto;
  });

  afterAll(() => {
    if (secretoAnterior === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = secretoAnterior;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([
    ['GET', '/usuarios', 'listarTodos'],
    ['POST', '/usuarios', 'crear'],
    ['GET', '/usuarios/by-email/alguien%40example.test', 'buscarPorCorreo'],
    ['PUT', '/usuarios/42/active', 'actualizarActivo'],
  ])('%s %s responde 401 sin JWT y no ejecuta su servicio', async (metodo, ruta, servicio) => {
    const operacion = jest.spyOn(userService, servicio);

    const respuesta = await request(app)[metodo.toLowerCase()](ruta).send({
      nombre: 'No debe procesarse',
      activo: true,
    });

    expect(respuesta.status).toBe(401);
    expect(respuesta.body).toEqual({ message: 'Autenticación requerida' });
    expect(operacion).not.toHaveBeenCalled();
  });

  test.each([
    ['GET', '/usuarios', 'listarTodos'],
    ['POST', '/usuarios', 'crear'],
    ['GET', '/usuarios/by-email/alguien%40example.test', 'buscarPorCorreo'],
    ['PUT', '/usuarios/42/active', 'actualizarActivo'],
  ])('%s %s responde 403 a estudiante sin ejecutar su servicio', async (metodo, ruta, servicio) => {
    jest.spyOn(userService, 'obtenerPorId').mockResolvedValue([cuentaActiva()]);
    const operacion = jest.spyOn(userService, servicio);

    const respuesta = await request(app)[metodo.toLowerCase()](ruta)
      .set('Authorization', `Bearer ${firmarTokenUsuario()}`)
      .send({ nombre: 'No debe procesarse', activo: true });

    expect(respuesta.status).toBe(403);
    expect(respuesta.body).toEqual({
      message: 'Operación administrativa no habilitada',
    });
    expect(operacion).not.toHaveBeenCalled();
  });

  test('resuelve /by-email antes de /:id y la bloquea sin consultar correo ni perfil', async () => {
    const obtenerPorId = jest
      .spyOn(userService, 'obtenerPorId')
      .mockResolvedValue([cuentaActiva()]);
    const buscarPorCorreo = jest.spyOn(userService, 'buscarPorCorreo');

    const respuesta = await request(app)
      .get('/usuarios/by-email/activa%40estudiantes.universidad.example')
      .set('Authorization', `Bearer ${firmarTokenUsuario()}`);

    expect(respuesta.status).toBe(403);
    expect(buscarPorCorreo).not.toHaveBeenCalled();
    expect(obtenerPorId).toHaveBeenCalledTimes(1);
    expect(obtenerPorId).toHaveBeenCalledWith(42);
  });

  test('GET /usuarios/:id exige JWT antes de consultar el perfil', async () => {
    const obtenerPorId = jest.spyOn(userService, 'obtenerPorId');

    const respuesta = await request(app).get('/usuarios/42');

    expect(respuesta.status).toBe(401);
    expect(respuesta.body).toEqual({ message: 'Autenticación requerida' });
    expect(obtenerPorId).not.toHaveBeenCalled();
  });

  test.each(['abc', '1.5', '0', '-1', '01', '2147483648'])(
    'GET /usuarios/%s responde 400 después de autenticar y antes de consultar el perfil',
    async (id) => {
      const obtenerPorId = jest
        .spyOn(userService, 'obtenerPorId')
        .mockResolvedValueOnce([cuentaActiva()]);

      const respuesta = await request(app)
        .get(`/usuarios/${id}`)
        .set('Authorization', `Bearer ${firmarTokenUsuario()}`);

      expect(respuesta.status).toBe(400);
      expect(respuesta.body).toEqual({ message: 'Identificador de usuario inválido' });
      expect(obtenerPorId).toHaveBeenCalledTimes(1);
    },
  );

  test('GET /usuarios/:id responde 403 para un ID válido ajeno sin consultar su perfil', async () => {
    const obtenerPorId = jest
      .spyOn(userService, 'obtenerPorId')
      .mockResolvedValueOnce([cuentaActiva()]);

    const respuesta = await request(app)
      .get('/usuarios/43')
      .set('Authorization', `Bearer ${firmarTokenUsuario()}`);

    expect(respuesta.status).toBe(403);
    expect(respuesta.body).toEqual({ message: 'No puede consultar otro perfil' });
    expect(obtenerPorId).toHaveBeenCalledTimes(1);
  });

  test('GET /usuarios/:id devuelve solo los campos permitidos del perfil propio', async () => {
    const perfil = {
      ...cuentaActiva(),
      contrasena: 'no-debe-exponerse',
      rol: 'superadmin',
      secreto_interno: 'no-debe-exponerse',
    };
    const obtenerPorId = jest
      .spyOn(userService, 'obtenerPorId')
      .mockResolvedValueOnce([cuentaActiva()])
      .mockResolvedValueOnce([perfil]);

    const respuesta = await request(app)
      .get('/usuarios/42')
      .set('Authorization', `Bearer ${firmarTokenUsuario()}`);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body).toEqual({
      usuario: {
        id: 42,
        nombre: 'Estudiante activa',
        correo: 'activa@estudiantes.universidad.example',
        foto: 'foto.jpg',
        activo: true,
        fecha_creacion: '2026-10-22 10:00',
      },
    });
    expect(respuesta.body.usuario).not.toHaveProperty('contrasena');
    expect(respuesta.body.usuario).not.toHaveProperty('rol');
    expect(obtenerPorId).toHaveBeenNthCalledWith(1, 42);
    expect(obtenerPorId).toHaveBeenNthCalledWith(2, 42);
  });

  test('GET /usuarios/:id responde 401 si la cuenta desaparece tras el middleware', async () => {
    const obtenerPorId = jest
      .spyOn(userService, 'obtenerPorId')
      .mockResolvedValueOnce([cuentaActiva()])
      .mockResolvedValueOnce([]);

    const respuesta = await request(app)
      .get('/usuarios/42')
      .set('Authorization', `Bearer ${firmarTokenUsuario()}`);

    expect(respuesta.status).toBe(401);
    expect(respuesta.body).toEqual({ message: 'Sesión inválida o expirada' });
    expect(obtenerPorId).toHaveBeenCalledTimes(2);
  });

  test('GET /usuarios/2147483647 acepta el límite superior para el perfil propio', async () => {
    const perfil = cuentaActiva(2147483647);
    const obtenerPorId = jest
      .spyOn(userService, 'obtenerPorId')
      .mockResolvedValueOnce([perfil])
      .mockResolvedValueOnce([perfil]);

    const respuesta = await request(app)
      .get('/usuarios/2147483647')
      .set('Authorization', `Bearer ${firmarTokenUsuario(2147483647)}`);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.usuario.id).toBe(2147483647);
    expect(obtenerPorId).toHaveBeenCalledTimes(2);
  });
});

describe('reportes propios protegidos y ruta legacy retirada', () => {
  const secretoAnterior = process.env.JWT_SECRET;
  const secreto = 'secreto-de-prueba-para-reportes-propios';

  function firmarTokenUsuario(id = 42) {
    return jwt.sign(
      { sub: String(id), ambito: 'estudiante' },
      secreto,
      { algorithm: 'HS256', issuer: 'FindU', expiresIn: '1h' },
    );
  }

  function cuentaActiva(id = 42) {
    return {
      id,
      nombre: 'Estudiante activa',
      correo: 'activa@estudiantes.universidad.example',
      foto: null,
      activo: true,
    };
  }

  beforeAll(() => {
    process.env.JWT_SECRET = secreto;
  });

  afterAll(() => {
    if (secretoAnterior === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = secretoAnterior;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    pool.query.mockReset();
  });

  test('GET /reportes/usuario/:usuarioId responde 401 sin JWT antes de consultar reportes', async () => {
    const obtenerReportes = jest.spyOn(reportService, 'obtenerReportesPorUsuario');

    const respuesta = await request(app).get('/reportes/usuario/42');

    expect(respuesta.status).toBe(401);
    expect(respuesta.body).toEqual({ message: 'Autenticación requerida' });
    expect(obtenerReportes).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  test.each(['abc', '1.5', '0', '-1', '01', '2147483648'])(
    'GET /reportes/usuario/%s responde 400 antes de consultar reportes',
    async (id) => {
      jest.spyOn(userService, 'obtenerPorId').mockResolvedValueOnce([cuentaActiva()]);
      const obtenerReportes = jest.spyOn(reportService, 'obtenerReportesPorUsuario');

      const respuesta = await request(app)
        .get(`/reportes/usuario/${id}`)
        .set('Authorization', `Bearer ${firmarTokenUsuario()}`);

      expect(respuesta.status).toBe(400);
      expect(respuesta.body).toEqual({ message: 'Identificador de usuario inválido' });
      expect(obtenerReportes).toHaveBeenCalledWith(id, 42);
      expect(pool.query).not.toHaveBeenCalled();
    },
  );

  test('GET /reportes/usuario/:usuarioId responde 403 para un ID válido ajeno sin consultar reportes', async () => {
    jest.spyOn(userService, 'obtenerPorId').mockResolvedValueOnce([cuentaActiva()]);
    const obtenerReportes = jest.spyOn(reportService, 'obtenerReportesPorUsuario');

    const respuesta = await request(app)
      .get('/reportes/usuario/43')
      .set('Authorization', `Bearer ${firmarTokenUsuario()}`);

    expect(respuesta.status).toBe(403);
    expect(respuesta.body).toEqual({ message: 'No puede consultar reportes de otro usuario' });
    expect(obtenerReportes).toHaveBeenCalledWith('43', 42);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('GET /reportes/usuario/:usuarioId consulta exclusivamente el actor e incluye activos y archivados en orden descendente', async () => {
    jest.spyOn(userService, 'obtenerPorId').mockResolvedValueOnce([cuentaActiva()]);
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 9, usuario_id: 42, imagen: 'nueva.jpg', activo: true },
        { id: 8, usuario_id: 42, imagen: 'archivada.jpg', activo: false },
      ],
    });

    const respuesta = await request(app)
      .get('/reportes/usuario/42')
      .set('Host', 'findu.example')
      .set('Authorization', `Bearer ${firmarTokenUsuario()}`);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body).toEqual({
      reports: [
        expect.objectContaining({
          id: 9,
          usuario_id: 42,
          activo: true,
          imageUrl: 'http://findu.example/uploads/nueva.jpg',
        }),
        expect.objectContaining({
          id: 8,
          usuario_id: 42,
          activo: false,
          imageUrl: 'http://findu.example/uploads/archivada.jpg',
        }),
      ],
    });
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE r\.usuario_id = \$1\s+ORDER BY r\.fecha_creacion DESC/),
      [42],
    );
    expect(pool.query.mock.calls[0][0]).toContain('r.activo');
    expect(pool.query.mock.calls[0][0]).not.toMatch(/r\.activo\s*=\s*TRUE/i);
  });

  test('GET /reportes/usuario/:usuarioId devuelve 200 con lista vacía', async () => {
    jest.spyOn(userService, 'obtenerPorId').mockResolvedValueOnce([cuentaActiva()]);
    pool.query.mockResolvedValueOnce({ rows: [] });

    const respuesta = await request(app)
      .get('/reportes/usuario/42')
      .set('Authorization', `Bearer ${firmarTokenUsuario()}`);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body).toEqual({ reports: [] });
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][1]).toEqual([42]);
  });

  test('GET /reportes/usuario/2147483647 acepta el límite superior propio', async () => {
    const perfil = cuentaActiva(2147483647);
    jest.spyOn(userService, 'obtenerPorId').mockResolvedValueOnce([perfil]);
    pool.query.mockResolvedValueOnce({ rows: [] });

    const respuesta = await request(app)
      .get('/reportes/usuario/2147483647')
      .set('Authorization', `Bearer ${firmarTokenUsuario(2147483647)}`);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body).toEqual({ reports: [] });
    expect(pool.query.mock.calls[0][1]).toEqual([2147483647]);
  });

  test.each([false, true])(
    'GET /reportes/user/:userId responde 404 con JWT=%s y ejecuta cero consultas',
    async (conJwt) => {
      const obtenerReportes = jest.spyOn(reportService, 'obtenerReportesPorUsuario');
      let solicitud = request(app).get('/reportes/user/42');
      if (conJwt) {
        solicitud = solicitud.set('Authorization', `Bearer ${firmarTokenUsuario()}`);
      }

      const respuesta = await solicitud;

      expect(respuesta.status).toBe(404);
      expect(obtenerReportes).not.toHaveBeenCalled();
      expect(pool.query).not.toHaveBeenCalled();
    },
  );
});
