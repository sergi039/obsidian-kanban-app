import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadConfig, PROJECT_ROOT, type AppConfig } from './config.js';

const RoutingRuleSchema = z.object({
  boardId: z.string(),
  domain: z.enum(['work', 'personal', 'property', 'unknown']).optional().default('unknown'),
  column: z.string().optional(),
  aliases: z.array(z.string()).default([]),
});

const RoutingConfigSchema = z.object({
  defaultBoard: z.string().optional(),
  clarifyBelowConfidence: z.number().min(0).max(1).default(0.85),
  clarifyWithinMargin: z.number().min(0).max(1).default(0.2),
  rules: z.array(RoutingRuleSchema).default([]),
});

export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;
const STRONG_SCORE_GAP = 3;

export interface RouteTaskResult {
  boardId: string | null;
  column: string | null;
  confidence: number;
  needsClarification: boolean;
  question?: string;
  reasonCode?: string;
  reason: string;
  candidates: Array<{ boardId: string; score: number; matched: string[] }>;
}

let cachedRouting: RoutingConfig | null = null;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-z0-9а-я]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(text: string): Set<string> {
  return new Set(normalize(text).split(' ').filter(Boolean));
}

function aliasMatches(normalizedText: string, tokens: Set<string>, alias: string): boolean {
  const normalizedAlias = normalize(alias);
  if (!normalizedAlias) return false;
  if (normalizedAlias.length <= 3 && !normalizedAlias.includes(' ')) {
    return tokens.has(normalizedAlias);
  }
  return normalizedText.includes(normalizedAlias);
}

function defaultAliasesForBoard(boardId: string, name: string, file: string): string[] {
  const base = [boardId, name, path.basename(file, '.md')];
  const id = boardId.toLowerCase();
  if (id === 'private' || /private|personal|личн/i.test(name)) {
    base.push('personal', 'private', 'личное', 'личный', 'дом', 'семья', 'здоровье', 'покупки', 'купить');
  }
  if (id === 'vs' || /virto.?software/i.test(name)) {
    base.push('work', 'работа', 'рабочее', 'клиент', 'код', 'релиз', 'virto', 'virtosoftware', 'vs');
  }
  if (id === 'vp' || /vp|virto.?property/i.test(name)) {
    base.push('work', 'работа', 'virto property', 'virtoproperty', 'vp', 'property catalog', '8085');
  }
  if (/property|cervantes|arrecife|reconstruction/i.test(`${boardId} ${name} ${file}`)) {
    base.push('property', 'недвижимость', 'ремонт', 'объект', 'reconstruction');
  }
  return Array.from(new Set(base));
}

function defaultDomainForBoard(boardId: string, name: string, file: string): 'work' | 'personal' | 'property' | 'unknown' {
  const text = `${boardId} ${name} ${file}`.toLowerCase();
  if (/private|personal|личн/.test(text)) return 'personal';
  if (/property|cervantes|arrecife|reconstruction/.test(text)) return 'property';
  if (/vs|vp|virto|business/.test(text)) return 'work';
  return 'unknown';
}

function confidenceFromScore(score: number): number {
  if (score >= 4) return 0.9;
  if (score >= 2) return 0.86;
  if (score > 0) return 0.6;
  return 0;
}

export function loadRoutingConfig(config?: AppConfig, routingPath?: string): RoutingConfig {
  if (cachedRouting && !routingPath) return cachedRouting;
  const appConfig = config ?? loadConfig();
  const p = routingPath ?? path.join(PROJECT_ROOT, 'config.routing.json');

  let raw: unknown | null = null;
  if (existsSync(p)) {
    raw = JSON.parse(readFileSync(p, 'utf-8'));
  }

  const defaults: RoutingConfig = {
    defaultBoard: appConfig.boards.find((b) => b.id === 'private')?.id ?? appConfig.boards[0]?.id,
    clarifyBelowConfidence: 0.85,
    clarifyWithinMargin: 0.2,
    rules: appConfig.boards
      .filter((board) => !board.archived)
      .map((board) => ({
        boardId: board.id,
        domain: defaultDomainForBoard(board.id, board.name, board.file),
        column: board.columns[0] ?? 'Backlog',
        aliases: defaultAliasesForBoard(board.id, board.name, board.file),
      })),
  };

  const parsed = raw ? RoutingConfigSchema.parse(raw) : defaults;
  const merged = raw
    ? {
        ...defaults,
        ...parsed,
        rules: parsed.rules.length > 0 ? parsed.rules : defaults.rules,
      }
    : parsed;

  if (!routingPath) cachedRouting = merged;
  return merged;
}

export function resetRoutingCache(): void {
  cachedRouting = null;
}

export function routeTask(
  text: string,
  options: { boardId?: string; config?: AppConfig; routing?: RoutingConfig; allowDefaultOnAmbiguous?: boolean } = {},
): RouteTaskResult {
  const config = options.config ?? loadConfig();
  const routing = options.routing ?? loadRoutingConfig(config);
  const explicitBoardId = options.boardId?.trim();

  if (explicitBoardId) {
    const board = config.boards.find((b) => b.id === explicitBoardId && !b.archived);
    if (!board) {
      return {
        boardId: null,
        column: null,
        confidence: 0,
        needsClarification: true,
        question: `Board "${explicitBoardId}" was not found. Which Kanban board should I use?`,
        reasonCode: 'explicit_board_not_found',
        reason: 'Explicit board was not found',
        candidates: [],
      };
    }
    return {
      boardId: board.id,
      column: board.columns[0] ?? 'Backlog',
      confidence: 1,
      needsClarification: false,
      reasonCode: 'explicit_board_requested',
      reason: `Explicit board "${board.id}" requested`,
      candidates: [{ boardId: board.id, score: 100, matched: ['explicit'] }],
    };
  }

  const normalizedText = normalize(text);
  const tokens = tokenSet(text);
  const candidates = routing.rules
    .map((rule) => {
      const board = config.boards.find((b) => b.id === rule.boardId && !b.archived);
      if (!board) return null;
      const matched = rule.aliases.filter((alias) => aliasMatches(normalizedText, tokens, alias));
      let score = matched.reduce((sum, alias) => {
        const normalizedAlias = normalize(alias);
        if (normalizedAlias === normalize(board.id) || normalizedAlias === normalize(board.name)) return sum + 4;
        if (normalizedAlias.includes(' ')) return sum + 3;
        return sum + 2;
      }, 0);
      if (matched.length > 1) score += matched.length - 1;
      return { boardId: rule.boardId, column: rule.column ?? board.columns[0] ?? 'Backlog', score, matched };
    })
    .filter((candidate): candidate is { boardId: string; column: string; score: number; matched: string[] } => candidate !== null)
    .sort((a, b) => b.score - a.score);

  const top = candidates[0];
  const second = candidates[1];
  if (!top || top.score === 0 || (second && second.score === top.score)) {
    if (options.allowDefaultOnAmbiguous && routing.defaultBoard) {
      const board = config.boards.find((b) => b.id === routing.defaultBoard && !b.archived);
      if (board) {
        return {
          boardId: board.id,
          column: board.columns[0] ?? 'Backlog',
          confidence: 0.5,
          needsClarification: false,
          reasonCode: 'default_board_used',
          reason: 'No confident routing match; default board used by caller policy',
          candidates,
        };
      }
    }
    return {
      boardId: null,
      column: null,
      confidence: 0,
      needsClarification: true,
      question: 'Which Kanban board should I use: work or personal?',
      reasonCode: top?.score === second?.score ? 'routing_tie' : 'no_alias_match',
      reason: top?.score === second?.score ? 'Routing tie' : 'No routing alias matched',
      candidates,
    };
  }

  const confidence = confidenceFromScore(top.score);
  const secondConfidence = second ? confidenceFromScore(second.score) : 0;
  const scoreGap = second ? top.score - second.score : Number.POSITIVE_INFINITY;
  const closeMatch = !!second && confidence - secondConfidence < routing.clarifyWithinMargin && scoreGap < STRONG_SCORE_GAP;
  if (confidence < routing.clarifyBelowConfidence || closeMatch) {
    return {
      boardId: null,
      column: null,
      confidence,
      needsClarification: true,
      question: candidates
        .filter((candidate) => candidate.score > 0)
        .slice(0, 5)
        .map((candidate) => config.boards.find((board) => board.id === candidate.boardId)?.name ?? candidate.boardId)
        .join(', ')
        ? `Which Kanban board should I use: ${candidates.filter((candidate) => candidate.score > 0).slice(0, 5).map((candidate) => config.boards.find((board) => board.id === candidate.boardId)?.name ?? candidate.boardId).join(', ')}?`
        : 'Which Kanban board should I use?',
      reason: confidence < routing.clarifyBelowConfidence
        ? `Best match "${top.boardId}" confidence ${confidence} is below threshold ${routing.clarifyBelowConfidence}`
        : `Best match "${top.boardId}" is too close to "${second?.boardId}"`,
      reasonCode: confidence < routing.clarifyBelowConfidence ? 'low_confidence' : 'close_match',
      candidates,
    };
  }

  return {
    boardId: top.boardId,
    column: top.column,
    confidence,
    needsClarification: false,
    reasonCode: 'matched_aliases',
    reason: `Matched aliases: ${top.matched.join(', ')}`,
    candidates,
  };
}
