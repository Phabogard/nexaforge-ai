const SENSITIVE_KEYS = new Set([
  'password',
  'pass',
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
  'session_id'
]);

const MAX_PAYLOAD_STRING_BYTES = 50000; // 50KB limit for audit payload json string

export class AuditPayloadSanitizer {
  static sanitize(obj: unknown, depth = 0): unknown {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string') {
      if (obj.includes('BEGIN PRIVATE KEY') || obj.includes('Bearer ')) {
        return '[REDACTED_SECRET_STRING]';
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
      if (SENSITIVE_KEYS.has(lowerKey) || lowerKey.endsWith('_secret') || lowerKey.endsWith('token') || lowerKey.endsWith('key')) {
        sanitizedObj[key] = '[REDACTED]';
      } else {
        sanitizedObj[key] = AuditPayloadSanitizer.sanitize(value, depth + 1);
      }
    }

    // Size check
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
