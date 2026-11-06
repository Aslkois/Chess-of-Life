import { addMove, branchStart, countBranches, createTree, deleteBranch, isHistorical, lineFrom, mainline, pathTo, sansOnPath, treeFromMoves, updateNode } from '../src/chess/tree';
import { positionKey } from '../src/chess/positionKey';

describe('variation tree', () => {
  const base = () => treeFromMoves(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']);

  it('creates branches from any position without changing the original game', () => {
    let tree = base();
    const original = mainline(tree).map((id) => tree.nodes[id].san);
    const line = mainline(tree);
    // branch at move 3 (white's 3rd move)
    let r = addMove(tree, line[4], 'Bc4', 'user');
    tree = r.tree;
    const bc4 = r.nodeId;
    r = addMove(tree, bc4, 'Bc5', 'user'); tree = r.tree;
    r = addMove(tree, r.nodeId, 'c3', 'engine'); tree = r.tree;
    // nested branch inside the alternative
    r = addMove(tree, bc4, 'Nf6', 'user'); tree = r.tree;
    const nf6 = r.nodeId;
    expect(mainline(tree).map((id) => tree.nodes[id].san)).toEqual(original);
    expect(countBranches(tree)).toBe(2);
    expect(branchStart(tree, nf6)).toBe(nf6);
    expect(branchStart(tree, bc4)).toBe(bc4);
    expect(branchStart(tree, line[3])).toBeNull();
    expect(sansOnPath(tree, pathTo(tree, nf6))).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6']);
    expect(lineFrom(tree, bc4).map((id) => tree.nodes[id].san)).toEqual(['Bc4', 'Bc5', 'c3']);
    expect(tree.nodes[bc4].source).toBe('user');
    expect(isHistorical(tree, line[2])).toBe(true);
  });

  it('does not duplicate identical moves and keeps trees immutable', () => {
    const t0 = base();
    const line = mainline(t0);
    const r = addMove(t0, line[1], 'e5', 'user');
    expect(r.existed).toBe(true);
    expect(r.nodeId).toBe(line[2]);
    const r2 = addMove(t0, line[1], 'c5', 'user');
    expect(t0.nodes[line[1]].children).toHaveLength(1);
    expect(r2.tree.nodes[line[1]].children).toHaveLength(2);
  });

  it('refuses to delete or rename the original game but deletes explored branches', () => {
    let tree = base();
    const line = mainline(tree);
    expect(() => deleteBranch(tree, line[3])).toThrow();
    expect(() => updateNode(tree, line[3], { branchName: 'x' })).toThrow();
    tree = updateNode(tree, line[3], { comment: 'a note' });
    expect(tree.nodes[line[3]].comment).toBe('a note');
    let r = addMove(tree, line[2], 'd4', 'user'); tree = r.tree;
    const d4 = r.nodeId;
    r = addMove(tree, d4, 'exd4', 'user'); tree = r.tree;
    tree = deleteBranch(tree, d4);
    expect(tree.nodes[d4]).toBeUndefined();
    expect(tree.nodes[r.nodeId]).toBeUndefined();
    expect(mainline(tree)).toEqual(line);
  });

  it('identifies transpositions with the same position key but separate histories', () => {
    let tree = createTree();
    let a = addMove(tree, tree.rootId, 'Nf3', 'user'); tree = a.tree;
    a = addMove(tree, a.nodeId, 'Nf6', 'user'); tree = a.tree;
    a = addMove(tree, a.nodeId, 'd4', 'user'); tree = a.tree;
    let b = addMove(tree, tree.rootId, 'd4', 'user'); tree = b.tree;
    b = addMove(tree, b.nodeId, 'Nf6', 'user'); tree = b.tree;
    b = addMove(tree, b.nodeId, 'Nf3', 'user'); tree = b.tree;
    expect(a.nodeId).not.toBe(b.nodeId);
    expect(positionKey(tree.nodes[a.nodeId].fen)).toBe(positionKey(tree.nodes[b.nodeId].fen));
    expect(sansOnPath(tree, pathTo(tree, a.nodeId))).toEqual(['Nf3', 'Nf6', 'd4']);
    expect(sansOnPath(tree, pathTo(tree, b.nodeId))).toEqual(['d4', 'Nf6', 'Nf3']);
  });

  it('handles large numbers of branches', () => {
    let tree = base();
    const line = mainline(tree);
    let n = 0;
    for (const parent of line) {
      for (const mv of ['a3', 'h3', 'a6', 'h6', 'Na3', 'Nh6']) {
        try { const r = addMove(tree, parent, mv, 'user'); tree = r.tree; if (!r.existed) n++; } catch { /* illegal here */ }
      }
    }
    expect(n).toBeGreaterThan(10);
    expect(countBranches(tree)).toBe(n);
    expect(mainline(tree)).toEqual(line);
  });
});
