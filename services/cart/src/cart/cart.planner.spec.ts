import {
  duplicateProductIds,
  exceedsBulkLimit,
  heldQuantities,
  planChanges,
  toCartLines,
} from './cart.planner';

/** The cart's arithmetic, tested without a Redis or an HTTP client in sight. */
describe('cart planner', () => {
  const held = (cart: Record<string, number>) => new Map(Object.entries(cart));

  describe('planChanges', () => {
    it('reserves the whole quantity for a product the cart does not hold', () => {
      const changes = planChanges(held({}), [{ productId: 'p1', quantity: 5 }]);

      expect(changes.reserve).toEqual([{ productId: 'p1', quantity: 5 }]);
      expect(changes.release).toEqual([]);
      expect(changes.writes).toEqual([{ productId: 'p1', quantity: 5 }]);
      expect(changes.size).toBe(1);
    });

    it('reserves only the difference when a held line goes up', () => {
      // The bug this replaces: 5 -> 10 asked inventory for another 10,
      // leaving it holding 15 against a cart that said 10.
      const changes = planChanges(held({ p1: 5 }), [
        { productId: 'p1', quantity: 10 },
      ]);

      expect(changes.reserve).toEqual([{ productId: 'p1', quantity: 5 }]);
      expect(changes.writes).toEqual([{ productId: 'p1', quantity: 10 }]);
    });

    it('releases the difference when a held line goes down', () => {
      const changes = planChanges(held({ p1: 10 }), [
        { productId: 'p1', quantity: 4 },
      ]);

      expect(changes.release).toEqual([{ productId: 'p1', quantity: 6 }]);
      expect(changes.reserve).toEqual([]);
      expect(changes.writes).toEqual([{ productId: 'p1', quantity: 4 }]);
    });

    it('plans nothing at all for a quantity already held', () => {
      const changes = planChanges(held({ p1: 5 }), [
        { productId: 'p1', quantity: 5 },
      ]);

      expect(changes.reserve).toEqual([]);
      expect(changes.release).toEqual([]);
      expect(changes.writes).toEqual([]);
      expect(changes.removals).toEqual([]);
    });

    it('removes the line and hands every unit back at zero', () => {
      const changes = planChanges(held({ p1: 3, p2: 1 }), [
        { productId: 'p1', quantity: 0 },
      ]);

      expect(changes.removals).toEqual(['p1']);
      expect(changes.writes).toEqual([]);
      expect(changes.release).toEqual([{ productId: 'p1', quantity: 3 }]);
      expect(changes.size).toBe(1);
    });

    it('ignores a removal for a product the cart never held', () => {
      const changes = planChanges(held({ p1: 3 }), [
        { productId: 'p9', quantity: 0 },
      ]);

      expect(changes.removals).toEqual([]);
      expect(changes.release).toEqual([]);
      expect(changes.size).toBe(1);
    });

    it('leaves lines the request does not name alone', () => {
      const changes = planChanges(held({ p1: 5, p2: 2 }), [
        { productId: 'p1', quantity: 6 },
      ]);

      expect(changes.writes).toEqual([{ productId: 'p1', quantity: 6 }]);
      expect(changes.size).toBe(2);
    });

    it('collects a rise and a fall into one batch each way', () => {
      const changes = planChanges(held({ p1: 5, p2: 2 }), [
        { productId: 'p1', quantity: 8 },
        { productId: 'p2', quantity: 1 },
        { productId: 'p3', quantity: 4 },
      ]);

      expect(changes.reserve).toEqual([
        { productId: 'p1', quantity: 3 },
        { productId: 'p3', quantity: 4 },
      ]);
      expect(changes.release).toEqual([{ productId: 'p2', quantity: 1 }]);
      expect(changes.size).toBe(3);
    });

    it('never mutates the quantities it was given', () => {
      const before = held({ p1: 5 });
      planChanges(before, [{ productId: 'p1', quantity: 9 }]);

      expect(before.get('p1')).toBe(5);
    });
  });

  describe('heldQuantities', () => {
    it('reads stored strings as numbers', () => {
      expect([...heldQuantities([['p1', '4']])]).toEqual([['p1', 4]]);
    });

    it.each([
      ['a non-numeric value', 'abc'],
      ['a fractional value', '1.5'],
      ['zero', '0'],
      ['a negative value', '-3'],
      ['an empty value', ''],
    ])('drops %s rather than poisoning a delta', (_label, raw) => {
      expect([...heldQuantities([['p1', raw]])]).toEqual([]);
    });
  });

  describe('toCartLines', () => {
    it('renders lines in a stable order', () => {
      expect(toCartLines(held({ p2: 1, p1: 2 }))).toEqual([
        { productId: 'p1', quantity: 2 },
        { productId: 'p2', quantity: 1 },
      ]);
    });
  });

  describe('duplicateProductIds', () => {
    it('names every product a request repeats', () => {
      expect(
        duplicateProductIds([
          { productId: 'p1', quantity: 1 },
          { productId: 'p1', quantity: 2 },
          { productId: 'p2', quantity: 1 },
        ]),
      ).toEqual(['p1']);
    });

    it('is quiet when every line is distinct', () => {
      expect(
        duplicateProductIds([
          { productId: 'p1', quantity: 1 },
          { productId: 'p2', quantity: 1 },
        ]),
      ).toEqual([]);
    });
  });

  describe('exceedsBulkLimit', () => {
    it('measures the whole cart, not the request', () => {
      const cart: Record<string, number> = {};
      for (let i = 0; i < 50; i += 1) cart[`p${i}`] = 1;

      // A single extra product tips a full cart past what one bulk release
      // could ever hand back.
      expect(
        exceedsBulkLimit(
          planChanges(held(cart), [{ productId: 'p99', quantity: 1 }]),
        ),
      ).toBe(true);
      expect(
        exceedsBulkLimit(
          planChanges(held(cart), [{ productId: 'p1', quantity: 2 }]),
        ),
      ).toBe(false);
    });
  });
});
