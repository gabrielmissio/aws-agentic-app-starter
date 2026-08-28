/**
 * Repairs streamed model output before it reaches the parser. Two failures are common enough to
 * handle rather than hope away:
 *
 *  - **A table that lost its line breaks.** GFM tables are line-based, so `| a | b | |---|---| | c |
 *    d |` on one line renders as a paragraph full of pipes. The delimiter row is the tell — prose
 *    essentially never contains one — so the cells re-chunk into rows by its column count.
 *  - **A code fence that has not closed yet.** Mid-stream an open ``` swallows the rest of the
 *    message; closing it for the parse keeps the block rendering from its first line.
 *
 * Text-in, text-out, and never applied inside a fenced block — a code sample may contain anything,
 * including a line that looks like a table.
 *
 * A repair, not a guarantee: anything that has to be *right* rather than merely readable belongs in
 * structured data the UI renders itself, not in prose the model retypes and this file patches up.
 */

/** Matches a delimiter row (`|---|---|`, `| :--- | ---: |`) wherever it appears. */
const DELIMITER_RUN = /\|(?:\s*:?-{1,}:?\s*\|)+/

/** A fence opener/closer: ``` or ~~~, optionally indented, with an optional info string. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/

/** Whether every cell on the line is a delimiter — `|---|---|`, `--- | :---:` — and there is one. */
function isDelimiterLine(line: string): boolean {
  const cells = cellsOf(line)
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell))
}

/** Splits a row's raw text into trimmed cells, dropping the empty edges the outer pipes produce. */
function cellsOf(row: string): string[] {
  return row
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell, i, all) => !(cell === '' && (i === 0 || i === all.length - 1)))
}

/**
 * Rebuilds a single line holding a whole flattened table. The delimiter row fixes the column count;
 * splitting on `|` yields the cells in order, an empty cell marking each row boundary. Prose the
 * model ran into the table is kept as its own paragraph. A delimiter row on a line of its own is a
 * correct table and is returned untouched.
 */
function rebuildFlattenedTable(line: string): string {
  const delimiter = DELIMITER_RUN.exec(line)
  if (!delimiter) return line

  const before = line.slice(0, delimiter.index)
  const after = line.slice(delimiter.index + delimiter[0].length)
  const columns = cellsOf(delimiter[0]).length
  if (columns === 0) return line

  // A table that is already line-based: the delimiter is the whole line.
  if (!before.includes('|') && !after.includes('|')) return line

  const headerCells = cellsOf(before)
  if (headerCells.length < columns) return line

  // Whatever precedes the header cells is prose that ran into the table.
  const prose = headerCells.slice(0, headerCells.length - columns).join(' | ').trim()
  const header = headerCells.slice(headerCells.length - columns)

  // The trailing cells re-chunk into rows: an empty cell is where one row ended and the next began.
  const rows: string[][] = []
  let current: string[] = []
  for (const cell of after.split('|').map((c) => c.trim())) {
    if (cell === '') {
      if (current.length > 0) {
        rows.push(current)
        current = []
      }
      continue
    }
    current.push(cell)
    if (current.length === columns) {
      rows.push(current)
      current = []
    }
  }
  if (current.length > 0) rows.push(current)

  const table = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n')

  return prose ? `${prose}\n\n${table}` : table
}

/**
 * Normalizes streamed markdown for rendering. `open` reports whether the content ends inside an
 * unclosed fence — a slip in a finished message, merely unfinished in a streaming one, and better
 * closed either way.
 */
export function normalizeMarkdown(content: string): string {
  const lines = content.split('\n')
  const out: string[] = []
  let fence: string | null = null

  for (const [i, line] of lines.entries()) {
    const fenceMatch = FENCE.exec(line)

    if (fence) {
      out.push(line)
      // A closing fence is at least as long as the one that opened the block.
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = null
      }
      continue
    }

    if (fenceMatch) {
      fence = fenceMatch[1]
      out.push(line)
      continue
    }

    const repaired = rebuildFlattenedTable(line)

    // A table starts at the header row above the delimiter row. GFM does not let one interrupt a
    // paragraph, so a header the model ran straight on from its own prose is read as more of that
    // paragraph and the table never forms. Only for a line the repair left alone — when it split a
    // flattened table it already separated the two.
    const previous = out[out.length - 1]
    if (
      repaired === line &&
      line.includes('|') &&
      isDelimiterLine(lines[i + 1] ?? '') &&
      previous !== undefined &&
      previous.trim() !== '' &&
      !previous.includes('|')
    ) {
      out.push('')
    }

    out.push(repaired)
  }

  // An unclosed block would otherwise swallow the rest of the message into a code block.
  if (fence) out.push(fence)

  return out.join('\n')
}

/**
 * Splits streaming content into the part safe to parse and the fragment still being written, at the
 * last line break: complete lines re-parse cleanly as the next arrives, while the unfinished line
 * stays plain text so a half-typed row never renders as a broken one.
 *
 * The exception is a line flattening a table onto itself — held back, it shows a growing wall of
 * pipes and then snaps into a table at the end. Once the delimiter row arrives the whole content
 * goes through the repair instead, so the table fills in row by row.
 */
export function splitStreamingMarkdown(content: string): { complete: string; tail: string } {
  const lastBreak = content.lastIndexOf('\n')
  const tail = lastBreak === -1 ? content : content.slice(lastBreak + 1)

  if (DELIMITER_RUN.test(tail)) return { complete: normalizeMarkdown(content), tail: '' }
  if (lastBreak === -1) return { complete: '', tail }

  return { complete: normalizeMarkdown(content.slice(0, lastBreak)), tail }
}
