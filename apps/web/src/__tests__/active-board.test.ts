import { afterEach, describe, expect, it } from 'vitest';
import {
  ACTIVE_BOARD_STORAGE_KEY,
  dropDeepLinkParams,
  loadActiveBoard,
  pickInitialBoard,
  storeActiveBoard,
} from '../lib/active-board';

const BOARDS = ['private', 'vs', 'cervantes'];

describe('pickInitialBoard', () => {
  it('opens a ?board= deep link over the remembered board', () => {
    expect(pickInitialBoard(BOARDS, 'cervantes', 'vs')).toBe('cervantes');
  });

  it('reopens the remembered board when the URL names none', () => {
    expect(pickInitialBoard(BOARDS, null, 'vs')).toBe('vs');
  });

  it('skips ids of boards that no longer exist', () => {
    expect(pickInitialBoard(BOARDS, 'gone', 'vs')).toBe('vs');
    expect(pickInitialBoard(BOARDS, null, 'gone')).toBe('private');
  });

  it('has no board when there are none', () => {
    expect(pickInitialBoard([], 'vs', 'vs')).toBeNull();
  });
});

describe('remembered board storage', () => {
  afterEach(() => window.localStorage.clear());

  it('round-trips the board id', () => {
    storeActiveBoard(window.localStorage, 'vs');
    expect(window.localStorage.getItem(ACTIVE_BOARD_STORAGE_KEY)).toBe('vs');
    expect(loadActiveBoard(window.localStorage)).toBe('vs');
  });

  it('degrades to "nothing remembered" when storage throws', () => {
    const broken = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    } as unknown as Storage;
    expect(() => storeActiveBoard(broken, 'vs')).not.toThrow();
    expect(loadActiveBoard(broken)).toBeNull();
    expect(loadActiveBoard(undefined)).toBeNull();
  });
});

describe('dropDeepLinkParams', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('removes board and card but keeps other params and the hash', () => {
    window.history.replaceState(null, '', '/?board=vs&card=abc&view=x#top');
    dropDeepLinkParams(window);
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe('/?view=x#top');
  });

  it('leaves a URL without deep-link params untouched', () => {
    window.history.replaceState(null, '', '/?view=x');
    dropDeepLinkParams(window);
    expect(window.location.search).toBe('?view=x');
  });
});
