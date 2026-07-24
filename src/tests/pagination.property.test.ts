import { arbitrary } from '../../arbitraries';
import { pagination } from '../../../utils/pagination';
import { expect } from '@jest/globals';

describe('pagination property test', () => {
  it('should visit every row exactly once with no duplicates or gaps', () => {
    // Generate a random dataset and page size
    const dataset = arbitrary.array(arbitrary.number);
    const pageSize = arbitrary.number({ min: 1, max: 10 });

    // Page through the dataset to exhaustion
    const pages = [];
    let cursor = null;
    do {
      const page = pagination(dataset, pageSize, cursor);
      pages.push(page);
      cursor = page.cursor;
    } while (cursor !== null);

    // Assert the union of all pages equals the dataset with no duplicates
    const union = pages.flat();
    expect(union).toEqual(dataset);
    expect(new Set(union).size).toBe(union.length);
  });

  it('should not cause a previously returned item to reappear or vanish when an item is inserted after the first page', () => {
    // Generate a random dataset and page size
    const dataset = arbitrary.array(arbitrary.number);
    const pageSize = arbitrary.number({ min: 1, max: 10 });

    // Page through the dataset to exhaustion
    const pages = [];
    let cursor = null;
    do {
      const page = pagination(dataset, pageSize, cursor);
      pages.push(page);
      cursor = page.cursor;
    } while (cursor !== null);

    // Insert an item after the first page
    const insertIndex = pageSize + 1;
    dataset.splice(insertIndex, 0, arbitrary.number());

    // Page through the updated dataset to exhaustion
    const updatedPages = [];
    cursor = null;
    do {
      const page = pagination(dataset, pageSize, cursor);
      updatedPages.push(page);
      cursor = page.cursor;
    } while (cursor !== null);

    // Assert the union of all updated pages equals the updated dataset with no duplicates
    const updatedUnion = updatedPages.flat();
    expect(updatedUnion).toEqual(dataset);
    expect(new Set(updatedUnion).size).toBe(updatedUnion.length);
  });
});