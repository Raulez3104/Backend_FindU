const request = require('supertest');
const express = require('express');
const app = require('../index'); 

describe('API /reports', () => {
  
  test('GET /reports - debería retornar todos los reportes', async () => {
    const res = await request(app).get('/reports');
    
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true); 
  });

  test('POST /reports - debería fallar si faltan campos', async () => {
    const res = await request(app)
      .post('/reports')
      .send({ title: 'Test' }); 
    
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toBe('Todos los campos son obligatorios');
  });

});
