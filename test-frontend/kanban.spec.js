'use strict';

const WOUtil = require('../public/js/wo-util');

describe('kanbanDefaultBoard', () => {
  it('seeds columns from the given titles, each with a unique id and no cards', () => {
    const board = WOUtil.kanbanDefaultBoard(['Backlog', 'Doing', 'Done']);
    expect(board.version).toBe(1);
    expect(board.columns.map((c) => c.title)).toEqual([
      'Backlog',
      'Doing',
      'Done',
    ]);
    expect(board.columns.every((c) => Array.isArray(c.cards) && !c.cards.length)).toBe(
      true,
    );
    const ids = board.columns.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('falls back to generic columns when no titles are given', () => {
    expect(WOUtil.kanbanDefaultBoard().columns.length).toBe(3);
  });
});

describe('kanbanNormalize', () => {
  it('parses a JSON string board', () => {
    const json = JSON.stringify({
      columns: [{ id: 'c1', title: 'A', cards: [{ id: 'k1', title: 'x' }] }],
    });
    const board = WOUtil.kanbanNormalize(json);
    expect(board.columns[0].title).toBe('A');
    expect(board.columns[0].cards[0].description).toBe('');
  });

  it('returns an empty valid board for blank, invalid JSON, or junk', () => {
    for (const input of ['', '   ', 'not json', null, undefined, 42, {}]) {
      const board = WOUtil.kanbanNormalize(input);
      expect(board.version).toBe(1);
      expect(Array.isArray(board.columns)).toBe(true);
    }
  });

  it('backfills missing ids and coerces bad card/column shapes', () => {
    const board = WOUtil.kanbanNormalize({
      columns: [
        { title: 'no id', cards: [{ title: 'card' }, 'garbage', null] },
        'nope',
      ],
    });
    expect(board.columns).toHaveLength(1);
    expect(board.columns[0].id).toMatch(/^c_/);
    expect(board.columns[0].cards).toHaveLength(1);
    expect(board.columns[0].cards[0].id).toMatch(/^k_/);
  });
});

describe('column mutations', () => {
  it('adds, renames and removes columns', () => {
    const board = WOUtil.kanbanNormalize({ columns: [] });
    WOUtil.kanbanAddColumn(board, 'First');
    expect(board.columns).toHaveLength(1);
    const id = board.columns[0].id;
    WOUtil.kanbanRenameColumn(board, id, 'Renamed');
    expect(board.columns[0].title).toBe('Renamed');
    WOUtil.kanbanRemoveColumn(board, id);
    expect(board.columns).toHaveLength(0);
  });

  it('moves a column to a new index (clamped)', () => {
    const board = WOUtil.kanbanDefaultBoard(['A', 'B', 'C']);
    const cId = board.columns[2].id;
    WOUtil.kanbanMoveColumn(board, cId, 0);
    expect(board.columns.map((c) => c.title)).toEqual(['C', 'A', 'B']);
    WOUtil.kanbanMoveColumn(board, cId, 99);
    expect(board.columns.map((c) => c.title)).toEqual(['A', 'B', 'C']);
  });
});

describe('card mutations', () => {
  function seed() {
    const board = WOUtil.kanbanDefaultBoard(['Todo', 'Done']);
    WOUtil.kanbanAddCard(board, board.columns[0].id, { title: 'task' });
    return board;
  }

  it('adds a card to the target column', () => {
    const board = seed();
    expect(board.columns[0].cards).toHaveLength(1);
    expect(board.columns[0].cards[0].title).toBe('task');
  });

  it('updates a card in place', () => {
    const board = seed();
    const id = board.columns[0].cards[0].id;
    WOUtil.kanbanUpdateCard(board, id, { title: 'edited', description: 'why' });
    expect(board.columns[0].cards[0].title).toBe('edited');
    expect(board.columns[0].cards[0].description).toBe('why');
  });

  it('removes a card', () => {
    const board = seed();
    const id = board.columns[0].cards[0].id;
    WOUtil.kanbanRemoveCard(board, id);
    expect(board.columns[0].cards).toHaveLength(0);
  });

  it('moves a card between columns at the given index', () => {
    const board = seed();
    const from = board.columns[0].id;
    const to = board.columns[1].id;
    WOUtil.kanbanAddCard(board, to, { title: 'existing' });
    const cardId = board.columns[0].cards[0].id;
    WOUtil.kanbanMoveCard(board, cardId, to, 0);
    expect(board.columns[0].cards).toHaveLength(0);
    expect(board.columns[1].cards.map((k) => k.title)).toEqual([
      'task',
      'existing',
    ]);
  });

  it('is a no-op when moving to a non-existent card or column', () => {
    const board = seed();
    const before = WOUtil.kanbanSerialize(board);
    WOUtil.kanbanMoveCard(board, 'ghost', board.columns[1].id, 0);
    expect(WOUtil.kanbanSerialize(board)).toBe(before);
  });
});

describe('card link / url / due fields', () => {
  it('normalizes link, url and due (defaulting to empty strings)', () => {
    const board = WOUtil.kanbanNormalize({
      columns: [
        {
          id: 'c1',
          title: 'A',
          cards: [
            { id: 'k1', title: 'x', link: 'Notes/Spec.md', url: 'https://ex.com', due: '2026-08-01' },
            { id: 'k2', title: 'y' },
          ],
        },
      ],
    });
    expect(board.columns[0].cards[0]).toMatchObject({
      link: 'Notes/Spec.md',
      url: 'https://ex.com',
      due: '2026-08-01',
    });
    expect(board.columns[0].cards[1]).toMatchObject({ link: '', url: '', due: '' });
  });

  it('updates link, url and due via kanbanUpdateCard', () => {
    const board = WOUtil.kanbanDefaultBoard(['Todo']);
    WOUtil.kanbanAddCard(board, board.columns[0].id, { title: 't' });
    const id = board.columns[0].cards[0].id;
    WOUtil.kanbanUpdateCard(board, id, {
      link: 'a/b.md',
      url: 'https://x.io',
      due: '2026-09-15',
    });
    expect(board.columns[0].cards[0]).toMatchObject({
      link: 'a/b.md',
      url: 'https://x.io',
      due: '2026-09-15',
    });
  });
});

describe('kanbanDueEntries', () => {
  it('flattens only dated cards, echoing board path + column', () => {
    const board = WOUtil.kanbanNormalize({
      columns: [
        { id: 'c1', title: 'Todo', cards: [
          { id: 'k1', title: 'due one', due: '2026-08-01' },
          { id: 'k2', title: 'no date' },
        ]},
        { id: 'c2', title: 'Done', cards: [
          { id: 'k3', title: 'due two', due: '2026-08-05' },
        ]},
      ],
    });
    const entries = WOUtil.kanbanDueEntries(board, 'Kanban/Roadmap.kanban');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      boardPath: 'Kanban/Roadmap.kanban',
      due: '2026-08-01',
      column: 'Todo',
      title: 'due one',
      cardId: 'k1',
    });
    expect(entries[1].column).toBe('Done');
  });

  it('returns [] for a board with no due dates', () => {
    const board = WOUtil.kanbanDefaultBoard(['A']);
    expect(WOUtil.kanbanDueEntries(board, 'x.kanban')).toEqual([]);
  });
});

describe('kanbanSerialize', () => {
  it('round-trips through normalize', () => {
    const board = WOUtil.kanbanDefaultBoard(['A']);
    WOUtil.kanbanAddCard(board, board.columns[0].id, {
      title: 'c',
      description: 'd',
    });
    const json = WOUtil.kanbanSerialize(board);
    expect(WOUtil.kanbanNormalize(json)).toEqual(board);
  });
});
