import request from 'supertest';
import app from '../../src/app.js';

export const api = () => request(app);

export function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}
