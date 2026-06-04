import { Hono } from 'hono';
import { z } from 'zod';
import { ingestCard, IngestError, SOURCE_VALUES } from '../ingest.js';
import { ingestTokenAuth } from '../middleware/security.js';
import { loadConfig } from '../config.js';
import { loadRoutingConfig, routeTask } from '../routing.js';

const inbox = new Hono();

const LinkSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
});

const CaptureSchema = z.object({
  title: z.string().optional(),
  text: z.string().optional(),
  description: z.string().optional(),
  board_id: z.string().optional(),
  column: z.string().optional(),
  links: z.array(LinkSchema).optional(),
  source: z.enum(SOURCE_VALUES).default('manual'),
  source_uid: z.string().optional(),
  source_url: z.string().url().optional(),
  source_meta: z.record(z.unknown()).optional(),
  context: z.string().optional(),
  allow_default_on_ambiguous: z.boolean().optional(),
});

const RouteSchema = z.object({
  title: z.string().optional(),
  text: z.string().optional(),
  description: z.string().optional(),
  board_id: z.string().optional(),
  context: z.string().optional(),
});

async function safeParseJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

inbox.use('*', ingestTokenAuth());

// POST /api/inbox/route — dry-run routing for agents before a write.
inbox.post('/route', async (c) => {
  const body = await safeParseJson(c);
  if (body === null) return c.json({ error: 'Invalid JSON body' }, 400);
  const parsed = RouteSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const text = `${parsed.data.title ?? parsed.data.text ?? ''} ${parsed.data.description ?? ''} ${parsed.data.context ?? ''}`.trim();
  if (!text) return c.json({ error: 'title or text is required' }, 400);

  const config = loadConfig();
  const route = routeTask(text, { boardId: parsed.data.board_id, config });
  return c.json({ route });
});

// GET /api/inbox/destinations — list routing destinations for MCP clients.
inbox.get('/destinations', (c) => {
  const includeArchived = c.req.query('archived') === 'true';
  const config = loadConfig();
  const routing = loadRoutingConfig(config);
  const destinations = config.boards
    .filter((board) => includeArchived || !board.archived)
    .map((board) => {
      const rule = routing.rules.find((r) => r.boardId === board.id);
      return {
        board_id: board.id,
        name: board.name,
        domain: rule?.domain ?? 'unknown',
        columns: board.columns,
        default_column: rule?.column ?? board.columns[0] ?? 'Backlog',
        categories: board.categories ?? [],
        priorities: board.priorities ?? [],
        aliases: rule?.aliases ?? [],
      };
    });
  return c.json({ destinations });
});

// POST /api/inbox/capture — create a routed card or ask for clarification.
inbox.post('/capture', async (c) => {
  const body = await safeParseJson(c);
  if (body === null) return c.json({ error: 'Invalid JSON body' }, 400);
  const parsed = CaptureSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const title = parsed.data.title ?? parsed.data.text;
  if (!title) return c.json({ error: 'title or text is required' }, 400);

  try {
    const result = ingestCard({
      title,
      boardId: parsed.data.board_id,
      column: parsed.data.column,
      description: parsed.data.description,
      links: parsed.data.links,
      source: parsed.data.source,
      sourceUid: parsed.data.source_uid,
      sourceUrl: parsed.data.source_url,
      sourceMeta: parsed.data.source_meta,
      context: parsed.data.context,
      allowDefaultOnAmbiguous: parsed.data.allow_default_on_ambiguous,
    });

    if ('needsClarification' in result && result.needsClarification) {
      return c.json({
        status: 'needs_clarification',
        clarification: {
          question: result.question,
          options: result.route.candidates
            .filter((candidate) => candidate.score > 0)
            .slice(0, 5)
            .map((candidate) => {
              const board = loadConfig().boards.find((b) => b.id === candidate.boardId);
              return {
                id: candidate.boardId,
                label: board?.name ?? candidate.boardId,
                board_id: candidate.boardId,
                column: board?.columns[0] ?? 'Backlog',
                reason: `Matched ${candidate.matched.join(', ')}`,
              };
            }),
        },
        route: result.route,
      });
    }

    if (!result.created) {
      return c.json({
        status: result.duplicate ? 'duplicate' : 'rejected',
        capture_key: result.captureKey,
        deleted: result.deleted,
      }, result.duplicate ? 200 : 400);
    }

    return c.json({
      status: result.duplicate ? 'duplicate' : 'created',
      card: result.card,
      route: result.route,
      capture_key: result.captureKey,
    }, result.duplicate ? 200 : 201);
  } catch (err) {
    if (err instanceof IngestError) {
      return c.json({ status: 'rejected', error: err.message, code: err.code }, err.status as 400 | 409);
    }
    return c.json({ status: 'rejected', error: `Failed to capture card: ${err}` }, 500);
  }
});

export default inbox;
