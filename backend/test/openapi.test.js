import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import SwaggerParser from '@apidevtools/swagger-parser';
import app from '../src/index.js';

describe('OpenAPI Contract Tests', () => {
  let api;
  let spec;

  beforeAll(async () => {
    api = request(app);
    spec = await SwaggerParser.validate('../openapi.json');
  });

  describe('OpenAPI Spec Validation', () => {
    it('should serve valid OpenAPI 3.1 spec at /openapi.json', async () => {
      const response = await api.get('/openapi.json');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('openapi', '3.1.0');
      expect(response.body).toHaveProperty('info');
      expect(response.body).toHaveProperty('paths');
      expect(response.body).toHaveProperty('components');
    });

    it('should have all required paths documented', () => {
      const documentedPaths = Object.keys(spec.paths);
      const requiredPaths = [
        '/healthz',
        '/api/services',
        '/api/services/{id}',
        '/api/services/{id}/deactivate',
        '/api/services/{id}/history',
        '/api/stats',
        '/api/registry/by-provider/{address}',
        '/api/registry/prepare-register',
        '/api/registry/prepare-deactivate',
        '/api/registry/submit-signed-tx',
        '/api/reputation/{id}',
        '/api/health',
        '/api/agents',
        '/api/agents/count',
        '/api/agents/stats',
        '/api/agents/{address}',
        '/api/agents/{address}/policy',
        '/api/agents/{address}/score',
        '/api/agents/{address}/eligible',
        '/api/agents/{address}/can-spend',
        '/api/agents/register',
        '/api/agents/{address}/payment',
        '/api/agents/{address}/payment-history',
        '/api/agents/{address}/check',
        '/api/agents/{address}/build-tx',
        '/api/agents/{address}/submit-signed-tx',
        '/api/agents/{address}/flag',
        '/api/admin/agents/{address}/flag',
        '/api/admin/agents/{address}/deactivate',
        '/api/agents/{address}/deactivate',
        '/api/agents/{address}/update-policy',
        '/api/agents/{address}/policy',
        '/demo/weather',
        '/demo/search',
        '/demo/activity',
        '/api/demo-run',
      ];

      requiredPaths.forEach(path => {
        expect(documentedPaths).toContain(path);
      });
    });

    it('should have all required schemas defined', () => {
      const schemas = Object.keys(spec.components?.schemas || {});
      const requiredSchemas = [
        'Error',
        'HealthResponse',
        'Service',
        'ServicesListResponse',
        'DeactivateServiceRequest',
        'PreparedTransaction',
        'ReputationHistoryResponse',
        'RegistryStats',
        'RegisterServiceRequest',
        'PrepareDeactivateRequest',
        'SubmitSignedTxRequest',
        'SubmitTxResponse',
        'ReputationRequest',
        'ReputationResponse',
        'ApiHealthResponse',
        'AgentsListResponse',
        'Agent',
        'CountResponse',
        'AgentStats',
        'AgentDetails',
        'AgentPolicy',
        'ScoreResponse',
        'EligibilityResponse',
        'CanSpendResponse',
        'RegisterAgentRequest',
        'RegisterAgentResponse',
        'PaymentRequest',
        'PaymentResponse',
        'PaymentHistoryResponse',
        'LegacyCheckResponse',
        'BuildAgentTxRequest',
        'BuildTxResponse',
        'SubmitAgentTxRequest',
        'SubmitAgentTxResponse',
        'FlagAgentRequest',
        'SuccessResponse',
        'UpdatePolicyRequest',
        'WeatherResponse',
        'SearchResponse',
        'ActivityFeedResponse',
        'DemoRunRequest',
        'DemoRunResponse',
      ];

      requiredSchemas.forEach(schema => {
        expect(schemas).toContain(schema);
      });
    });
  });

  describe('Response Schema Validation', () => {
    it('GET /healthz should match HealthResponse schema', async () => {
      const response = await api.get('/healthz');
      expect(response.status).toBe(200);
      
      const schema = spec.components.schemas.HealthResponse;
      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('rpc');
      expect(response.body).toHaveProperty('contract');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('queueDepth');
      expect(response.body).toHaveProperty('pendingTransactions');
    });

    it('GET /api/services should match ServicesListResponse schema', async () => {
      const response = await api.get('/api/services');
      expect(response.status).toBe(200);
      
      expect(response.body).toHaveProperty('services');
      expect(response.body).toHaveProperty('count');
      expect(Array.isArray(response.body.services)).toBe(true);
    });

    it('GET /api/agents should match AgentsListResponse schema', async () => {
      const response = await api.get('/api/agents');
      // This might return 503 if agents contract is not configured
      expect([200, 503]).toContain(response.status);
      
      if (response.status === 200) {
        expect(response.body).toHaveProperty('agents');
        expect(response.body).toHaveProperty('total');
        expect(response.body).toHaveProperty('page');
        expect(response.body).toHaveProperty('pageSize');
        expect(Array.isArray(response.body.agents)).toBe(true);
      }
    });

    it('GET /api/stats should match RegistryStats schema', async () => {
      const response = await api.get('/api/stats');
      expect(response.status).toBe(200);
      
      expect(response.body).toHaveProperty('totalServices');
      expect(response.body).toHaveProperty('categories');
      expect(Array.isArray(response.body.categories)).toBe(true);
    });

    it('Error responses should match Error schema', async () => {
      const response = await api.get('/api/services/invalid');
      expect(response.status).toBe(400);
      
      expect(response.body).toHaveProperty('error');
      expect(response.body).toHaveProperty('code');
    });
  });

  describe('OpenAPI Spec Endpoint', () => {
    it('should return spec with correct content-type', async () => {
      const response = await api.get('/openapi.json');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
    });

    it('spec should be valid OpenAPI 3.1', async () => {
      const response = await api.get('/openapi.json');
      expect(response.status).toBe(200);
      
      const spec = response.body;
      expect(spec.openapi).toBe('3.1.0');
      expect(spec.info).toHaveProperty('title');
      expect(spec.info).toHaveProperty('version');
      expect(spec.paths).toBeInstanceOf(Object);
      expect(spec.components).toBeInstanceOf(Object);
    });
  });
});
