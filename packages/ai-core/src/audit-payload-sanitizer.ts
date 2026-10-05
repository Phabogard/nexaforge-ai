const SENSITIVE_KEYS = new Set([
  'password',
  'pass',
  'passwd',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'secret',
  'privatekey',
  'private_key',
  'credentials',
  'auth',
  'bearer',
  'sessionid',
  'session_id',
  'env',
  'dotenv'
]);

const SENSITIVE_PATTERNS = [
  /BEGIN\s+PRIVATE\s+KEY/i,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/i,
  /([A-Z0-9_]{3,})\s*=\s*([^\s]+)/ // matches KEY=VAL .env patterns
];

const MAX_PAYLOAD_STRING_BYTES = 50000;

export class AuditPayloadSanitizer {
  static sanitize(obj: unknown, depth = 0): unknown {
    if (obj === null || obj === undefined) return obj;

    if (typeof obj === 'string') {
      if (obj.includes('BEGIN PRIVATE KEY') || obj.toLowerCase().includes('bearer ')) {
        return '[REDACTED_SECRET_STRING]';
      }
      // Check .env string pattern
      if (/^[A-Z0-9_]+=.+/i.test(obj.trim())) {
        return '[REDACTED_ENV_STRING]';
      }
      if (obj.length > 5000) {
        return obj.slice(0, 5000) + '...[TRUNCATED]';
      }
      return obj;
    }

    if (typeof obj !== 'object') return obj;

    if (depth > 10) return '[MAX_DEPTH_REACHED]';

    if (Array.isArray(obj)) {
      return obj.map(item => AuditPayloadSanitizer.sanitize(item, depth + 1));
    }

    const sanitizedObj: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (
        SENSITIVE_KEYS.has(lowerKey) ||
        lowerKey.endsWith('_secret') ||
        lowerKey.endsWith('token') ||
        lowerKey.endsWith('key') ||
        lowerKey.includes('pass')
      ) {
        sanitizedObj[key] = '[REDACTED]';
      } else {
        sanitizedObj[key] = AuditPayloadSanitizer.sanitize(value, depth + 1);
      }
    }

    try {
      const jsonStr = JSON.stringify(sanitizedObj);
      if (jsonStr.length > MAX_PAYLOAD_STRING_BYTES) {
        return { _warning: 'Payload truncated due to size limit', snippet: jsonStr.slice(0, 1000) + '...[TRUNCATED]' };
      }
    } catch {
      return '[UNSERIALIZABLE_PAYLOAD]';
    }

    return sanitizedObj;
  }
}
