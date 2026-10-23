const request = require('supertest');
const app = require('../app');
const pool = require('../config/database');

// Cierra el pool de pg para que Jest salga limpio (sin handles abiertos).
afterAll(async () => {
  await pool.end();
});

describe('API /reportes', () => {

  test('POST /reportes - retorna 401 sin JWT antes de validar campos', async () => {
    const res = await request(app)
      .post('/reportes')
      .send({ titulo: 'Carnet UCB' });
    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe('Autenticación requerida');
  });

  test('POST /reportes - retorna 401 sin JWT con body vacío', async () => {
    const res = await request(app).post('/reportes').send({});
    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe('Autenticación requerida');
  });

});

describe('Rutas inexistente', () => {
  test('GET /reports (inglés) - no existe, devuelve 404', async () => {
    const res = await request(app).get('/reports');
    expect(res.statusCode).toBe(404);
  });
});
