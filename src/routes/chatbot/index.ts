import type { FastifyInstance } from 'fastify';

export async function registerChatbotIndexRoute(app: FastifyInstance): Promise<void> {
  app.get('/chatbot', async (_req, reply) => {
    void reply.redirect('/chatbot/conversations');
  });
}