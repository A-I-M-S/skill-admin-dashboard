import 'fastify';
import '@fastify/session';

declare module 'fastify' {
  interface Session {
    user?: {
      userId: string;
      createdAt: string;
      lastSeenAt: string;
      isAdmin: boolean;
    };
    'csrf-secret'?: string;
  }
}

export {};
