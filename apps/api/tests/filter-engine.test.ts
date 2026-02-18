import { describe, it, expect } from 'vitest';
import { parseFilterQuery, compileFilter } from '../src/filter-engine.js';

describe('parseFilterQuery', () => {
  it('parses empty string', () => {
    const result = parseFilterQuery('');
    expect(result.tokens).toEqual([]);
    expect(result.freeText).toEqual([]);
  });

  it('parses single qualifier', () => {
    const result = parseFilterQuery('status:Done');
    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0]).toEqual({ negated: false, qualifier: 'status', values: ['Done'] });
  });

  it('parses negated qualifier', () => {
    const result = parseFilterQuery('-status:Backlog');
    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0]).toEqual({ negated: true, qualifier: 'status', values: ['Backlog'] });
  });

  it('parses multi-value qualifier', () => {
    const result = parseFilterQuery('priority:high,urgent');
    expect(result.tokens[0].values).toEqual(['high', 'urgent']);
  });

  it('parses free text', () => {
    const result = parseFilterQuery('calendar task');
    expect(result.tokens).toHaveLength(0);
    expect(result.freeText).toEqual(['calendar', 'task']);
  });

  it('parses mixed query', () => {
    const result = parseFilterQuery('status:Done priority:high calendar');
    expect(result.tokens).toHaveLength(2);
    expect(result.freeText).toEqual(['calendar']);
  });

  it('parses negated label', () => {
    const result = parseFilterQuery('-label:bug');
    expect(result.tokens[0]).toEqual({ negated: true, qualifier: 'label', values: ['bug'] });
  });

  it('parses due filter', () => {
    const result = parseFilterQuery('due:overdue');
    expect(result.tokens[0]).toEqual({ negated: false, qualifier: 'due', values: ['overdue'] });
  });

  it('parses done filter', () => {
    const result = parseFilterQuery('done:yes');
    expect(result.tokens[0]).toEqual({ negated: false, qualifier: 'done', values: ['yes'] });
  });

  it('parses has filter', () => {
    const result = parseFilterQuery('has:description');
    expect(result.tokens[0]).toEqual({ negated: false, qualifier: 'has', values: ['description'] });
  });

  it('ignores unknown qualifiers as free text', () => {
    const result = parseFilterQuery('unknown:value');
    expect(result.tokens).toHaveLength(0);
    expect(result.freeText).toEqual(['unknown:value']);
  });

  it('handles quoted strings', () => {
    const result = parseFilterQuery('"multi word search" status:Done');
    expect(result.freeText).toEqual(['multi word search']);
    expect(result.tokens).toHaveLength(1);
  });

  it('skips empty values (status:,)', () => {
    const result = parseFilterQuery('status:,');
    expect(result.tokens).toHaveLength(0);
  });

  it('skips qualifier with only commas', () => {
    const result = parseFilterQuery('priority:,,');
    expect(result.tokens).toHaveLength(0);
  });

  it('handles complex real-world query', () => {
    const result = parseFilterQuery('-status:Backlog,Done priority:high -label:wontfix calendar');
    expect(result.tokens).toHaveLength(3);
    expect(result.tokens[0]).toEqual({ negated: true, qualifier: 'status', values: ['Backlog', 'Done'] });
    expect(result.tokens[1]).toEqual({ negated: false, qualifier: 'priority', values: ['high'] });
    expect(result.tokens[2]).toEqual({ negated: true, qualifier: 'label', values: ['wontfix'] });
    expect(result.freeText).toEqual(['calendar']);
  });
});

describe('compileFilter', () => {
  it('compiles empty filter to 1=1', () => {
    const result = compileFilter({ tokens: [], freeText: [] });
    expect(result.where).toBe('1=1');
    expect(result.params).toEqual([]);
  });

  it('compiles status filter', () => {
    const parsed = parseFilterQuery('status:Done');
    const result = compileFilter(parsed);
    expect(result.where).toBe("column_name = ?");
    expect(result.params).toEqual(['Done']);
  });

  it('compiles negated status', () => {
    const parsed = parseFilterQuery('-status:Backlog');
    const result = compileFilter(parsed);
    expect(result.where).toBe("column_name != ?");
    expect(result.params).toEqual(['Backlog']);
  });

  it('compiles multi-value status', () => {
    const parsed = parseFilterQuery('status:Done,Review');
    const result = compileFilter(parsed);
    expect(result.where).toBe("column_name IN (?,?)");
    expect(result.params).toEqual(['Done', 'Review']);
  });

  it('compiles priority filter', () => {
    const parsed = parseFilterQuery('priority:high');
    const result = compileFilter(parsed);
    expect(result.where).toBe("priority = ?");
    expect(result.params).toEqual(['high']);
  });

  it('compiles priority:none', () => {
    const parsed = parseFilterQuery('priority:none');
    const result = compileFilter(parsed);
    expect(result.where).toBe("priority IS NULL");
  });

  it('compiles label filter', () => {
    const parsed = parseFilterQuery('label:bug');
    const result = compileFilter(parsed);
    expect(result.where).toContain('LIKE');
    expect(result.params).toEqual(['%"bug"%']);
  });

  it('compiles negated label', () => {
    const parsed = parseFilterQuery('-label:bug');
    const result = compileFilter(parsed);
    expect(result.where).toContain('NOT LIKE');
  });

  it('compiles due:overdue', () => {
    const parsed = parseFilterQuery('due:overdue');
    const result = compileFilter(parsed);
    expect(result.where).toContain("due_date");
    expect(result.where).toContain("date('now')");
  });

  it('compiles due:today', () => {
    const parsed = parseFilterQuery('due:today');
    const result = compileFilter(parsed);
    expect(result.where).toContain("date('now')");
  });

  it('compiles due:none', () => {
    const parsed = parseFilterQuery('due:none');
    const result = compileFilter(parsed);
    expect(result.where).toBe("due_date IS NULL");
  });

  it('compiles due with literal date', () => {
    const parsed = parseFilterQuery('due:2026-03-01');
    const result = compileFilter(parsed);
    expect(result.where).toBe("due_date = ?");
    expect(result.params).toEqual(['2026-03-01']);
  });

  it('compiles done:yes', () => {
    const parsed = parseFilterQuery('done:yes');
    const result = compileFilter(parsed);
    expect(result.where).toBe("is_done = ?");
    expect(result.params).toEqual([1]);
  });

  it('compiles done:no', () => {
    const parsed = parseFilterQuery('done:no');
    const result = compileFilter(parsed);
    expect(result.where).toBe("is_done = ?");
    expect(result.params).toEqual([0]);
  });

  it('compiles has:description', () => {
    const parsed = parseFilterQuery('has:description');
    const result = compileFilter(parsed);
    expect(result.where).toContain("description IS NOT NULL");
  });

  it('compiles has:comments', () => {
    const parsed = parseFilterQuery('has:comments');
    const result = compileFilter(parsed);
    expect(result.where).toContain("EXISTS");
    expect(result.where).toContain("comments");
  });

  it('compiles -has:priority', () => {
    const parsed = parseFilterQuery('-has:priority');
    const result = compileFilter(parsed);
    expect(result.where).toBe("priority IS NULL");
  });

  it('compiles free text search', () => {
    const parsed = parseFilterQuery('calendar zoom');
    const result = compileFilter(parsed);
    expect(result.where).toBe("title LIKE ? AND title LIKE ?");
    expect(result.params).toEqual(['%calendar%', '%zoom%']);
  });

  it('compiles complex mixed query', () => {
    const parsed = parseFilterQuery('-status:Done priority:high calendar');
    const result = compileFilter(parsed);
    expect(result.where).toContain("column_name != ?");
    expect(result.where).toContain("priority = ?");
    expect(result.where).toContain("title LIKE ?");
    expect(result.params).toEqual(['Done', 'high', '%calendar%']);
  });
});
