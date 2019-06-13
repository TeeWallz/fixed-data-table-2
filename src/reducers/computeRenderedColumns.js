/**
 * Copyright Schrodinger, LLC
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule computeRenderedColumns
 */

'use strict';

import clamp from 'lodash/clamp';
import columnWidths from 'columnWidths';
import scrollbarsVisibleSelector from 'scrollbarsVisible';
import { updateColumnWidth, updateColumnGroupWidth } from 'updateColumnWidth';

export default function computeRenderedColumns(state, columnAnchor) {
  // clone state
  const newState = Object.assign({}, state);
  
  // get buffer and viewport range
  const columnRange = calculateRenderedColumnRange(newState, columnAnchor);
  
  // update the offsets and buffer mapping
  computeRenderedColumnOffsets(newState, columnRange, newState.scrolling);

  // scrollX might have changed due to change in columns and offsets
  let scrollX = state.scrollX;
  if (columnRange.firstViewportCol !== columnRange.endViewportCol) {
    scrollX = newState.columnOffsets[columnRange.firstViewportCol] - newState.firstColumnOffset;
  }
  const { maxScrollX } = columnWidths(state);
  newState.scrollX = clamp(scrollX, 0, maxScrollX);

  return newState;
}

/**
 * Determine the range of columns to render (buffer and viewport)
 * The leading and trailing buffer is based on a fixed count,
 * while the viewport columns are based on their width and the viewport width.
 * We use the columnAnchor to determine what either the first or last column
 * will be, as well as the offset.
 *
 * NOTE (jordan) This alters state so it shouldn't be called
 * without state having been cloned first.
 *
 * @param {!Object} state
 * @param {{
 *   firstIndex: number,
 *   firstOffset: number,
 *   lastIndex: number,
 * }} columnAnchor
 * @return {{
 *   endBufferCol: number,
 *   endViewportCol: number,
 *   firstBufferCol: number,
 *   firstViewportCol: number,
 * }}
 * @private
 */
function calculateRenderedColumnRange(state, columnAnchor) {
  const bufferColumnCount = 0; // TODO (pradeep): calculate this similar to bufferRowCount
  const { availableScrollWidth, scrollableColumns } = columnWidths(state);
  const columnCount = scrollableColumns.length;

  if (availableScrollWidth === 0 || columnCount === 0) {
    state.firstColumnIndex = 0;
    state.endColumnIndex = 0;
    state.firstColumnOffset = 0;
    return {
      endBufferCol: 0,
      endViewportCol: 0,
      firstBufferCol: 0,
      firstViewportCol: 0,
    };
  }

  // If our first or last index is greater than our columnCount,
  // treat it as if the last column is at the end of the viewport
  let { firstIndex, firstOffset, lastIndex } = columnAnchor;
  if (firstIndex >= columnCount || lastIndex >= columnCount) {
    lastIndex = columnCount - 1;
  }

  // Walk the viewport until filled with columns
  // If lastIndex is set, walk backward so that column is the last in the viewport
  let step = 1;
  let startIdy = firstIndex;
  let totalWidth = firstOffset;
  if (lastIndex !== undefined) {
    step = -1;
    startIdy = lastIndex;
    totalWidth = 0;
  }

  // Loop to walk the viewport until we've touched enough columns to fill its width
  let columnIdx = startIdy;
  let endIdy = columnIdx;
  while (columnIdx < columnCount && columnIdx >= 0 &&
      totalWidth < availableScrollWidth) {
    totalWidth += updateColumnWidth(state, columnIdx);
    endIdy = columnIdx;
    columnIdx += step;
  }

  // Loop to walk the leading buffer
  let firstViewportCol = Math.min(startIdy, endIdy);
  const firstBufferCol = Math.max(firstViewportCol - bufferColumnCount, 0);
  for (columnIdx = firstBufferCol; columnIdx < firstViewportCol; columnIdx++) {
    updateColumnWidth(state, columnIdx);
  }

  // Loop to walk the trailing buffer
  const endViewportCol = Math.max(startIdy, endIdy) + 1;
  const endBufferCol = Math.min(endViewportCol + bufferColumnCount, columnCount);
  for (columnIdx = endViewportCol; columnIdx < endBufferCol; columnIdx++) {
    updateColumnWidth(state, columnIdx);
  }

  // Calculate offset needed to position column at the end of viewport
  // This should be negative and represent how far the first column needs to be offscreen
  if (lastIndex !== undefined) {
    firstOffset = Math.min(availableScrollWidth - totalWidth, 0);
  }

  state.firstColumnIndex = firstViewportCol;
  state.endColumnIndex = endViewportCol;
  state.firstColumnOffset = firstOffset;

  return {
    endBufferCol,
    endViewportCol,
    firstBufferCol,
    firstViewportCol,
  };
}

/**
 * Walk the columns to render and compute the width offsets and
 * positions in the column buffer.
 *
 * NOTE (jordan) This alters state so it shouldn't be called
 * without state having been cloned first.
 *
 * @param {!Object} state
 * @param {{
 *   endBufferCol: number,
 *   endViewportCol: number,
 *   firstBufferCol: number,
 *   firstViewportCol: number,
 * }} columnRange
 * @param {boolean} viewportOnly
 * @private
 */
function computeRenderedColumnOffsets(state, columnRange, viewportOnly) {
  const { columnBufferSet, columnOffsetIntervalTree } = state;
  const {
    endBufferCol,
    endViewportCol,
    firstBufferCol,
    firstViewportCol,
  } = columnRange;

  const renderedColumnsCount = endBufferCol - firstBufferCol;
  if (renderedColumnsCount === 0) {
    state.columnOffsets = {};
    state.columnsToRender = [];
    return;
  }

  const startIdx = viewportOnly ? firstViewportCol : firstBufferCol;
  const endIdx = viewportOnly ? endViewportCol : endBufferCol;

  // output for this function
  const columns = []; // state.columnsToRender
  const columnOffsets = {}; // state.columnOffsets

  // incremental way for calculating columnOffset
  let runningOffset = columnOffsetIntervalTree.sumUntil(startIdx);

  // compute column index and offsets for every columns inside the buffer
  for (let columnIdx = startIdx; columnIdx < endIdx; columnIdx++) {

    // Update the offset for rendering the column
    columnOffsets[columnIdx] = runningOffset;
    runningOffset += columnOffsetIntervalTree.get(columnIdx);

    // Get position for the viewport column
    const columnPosition = addColumnToBuffer(columnIdx, columnBufferSet, startIdx, endIdx, renderedColumnsCount);
    columns[columnPosition] = columnIdx;
  }

  // now we modify the state with the newly calculated columns and offsets
  state.columnsToRender = columns;
  state.columnOffsets = columnOffsets;
}

/**
 * Add the column to the buffer set if it doesn't exist.
 * If addition isn't possible due to max buffer size, it'll replace an existing element outside the given range.
 *
 * @param {!number} columnIdx
 * @param {!number} columnBufferSet
 * @param {!number} startRange
 * @param {!number} endRange
 * @param {!number} maxBufferSize
 *
 * @return {?number} the position of the column after being added to the buffer set
 * @private
 */
function addColumnToBuffer(columnIdx, columnBufferSet, startRange, endRange, maxBufferSize) {
  // Check if column already has a position in the buffer
  let columnPosition = columnBufferSet.getValuePosition(columnIdx);

  // Request a position in the buffer through eviction of another column
  if (columnPosition === null && columnBufferSet.getSize() >= maxBufferSize)  {
    columnPosition = columnBufferSet.replaceFurthestValuePosition(
      startRange,
      endRange - 1, // replaceFurthestValuePosition uses closed interval from startRange to endRange
      columnIdx
    );
  }

  if (columnPosition === null) {
    columnPosition = columnBufferSet.getNewPositionForValue(columnIdx);
  }

  return columnPosition;
}