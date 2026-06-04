import { describe, expect, it } from 'vitest';
import { routeTask, type RoutingConfig } from '../src/routing.js';
import type { AppConfig } from '../src/config.js';

const config: AppConfig = {
  vaultRoot: '/tmp/vault',
  defaultColumns: ['Backlog', 'Done'],
  boards: [
    { id: 'vs', name: 'VirtoSoftware', file: 'Business/VS.md', columns: ['Backlog', 'Done'] },
    { id: 'vp', name: 'VP', file: 'Business/VP.md', columns: ['Backlog', 'Done'] },
    { id: 'private', name: 'Private', file: 'Private/Tasks.md', columns: ['Backlog', 'Done'] },
    { id: 'cervantes', name: 'Cervantes', file: 'Properties/Cervantes.md', columns: ['Backlog', 'Done'] },
    { id: 'arrecife-reconstruction', name: 'Arrecife Reconstruction', file: 'Properties/Arrecife.md', columns: ['Backlog', 'Done'] },
  ],
};

const routing: RoutingConfig = {
  defaultBoard: 'private',
  clarifyBelowConfidence: 0.85,
  clarifyWithinMargin: 0.2,
  rules: [
    { boardId: 'vs', domain: 'work', column: 'Backlog', aliases: ['virto', 'virtosoftware', 'vs', 'работа'] },
    { boardId: 'vp', domain: 'work', column: 'Backlog', aliases: ['vp', 'virto property', 'property catalog', '8085', 'работа'] },
    { boardId: 'private', domain: 'personal', column: 'Backlog', aliases: ['private', 'personal', 'покупки', 'купить'] },
    { boardId: 'cervantes', domain: 'property', column: 'Backlog', aliases: ['cervantes', 'property', 'ремонт'] },
    { boardId: 'arrecife-reconstruction', domain: 'property', column: 'Backlog', aliases: ['arrecife', 'property', 'ремонт'] },
  ],
};

describe('routeTask', () => {
  it('routes strong board aliases without clarification', () => {
    const result = routeTask('Fix docs page for VirtoSoftware', { config, routing });
    expect(result.needsClarification).toBe(false);
    expect(result.boardId).toBe('vs');
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('asks for clarification on generic work signals with multiple work boards', () => {
    const result = routeTask('работа: проверить договор', { config, routing });
    expect(result.needsClarification).toBe(true);
    expect(result.boardId).toBeNull();
    expect(result.candidates.filter((candidate) => candidate.score > 0).map((candidate) => candidate.boardId)).toEqual(['vs', 'vp']);
  });

  it('routes personal aliases to private', () => {
    const result = routeTask('купить батарейки и продукты', { config, routing });
    expect(result.needsClarification).toBe(false);
    expect(result.boardId).toBe('private');
  });

  it('lets strong VP aliases dominate generic property aliases', () => {
    const result = routeTask('Починить property catalog 8085 фильтры', { config, routing });
    expect(result.needsClarification).toBe(false);
    expect(result.boardId).toBe('vp');
    expect(result.candidates[0]).toMatchObject({ boardId: 'vp' });
  });
});
