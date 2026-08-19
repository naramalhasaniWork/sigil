/**
 * Signups as CSV, for the day the list moves into a mail tool.
 *
 * RFC 4180 quoting, CRLF line endings, and one deliberate extra: a cell whose
 * first character is `=`, `+`, `-` or `@` is prefixed with an apostrophe. Excel
 * and Sheets treat those as the start of a formula, so a `source` value that
 * arrived over HTTP could otherwise execute when the owner opens the file. The
 * apostrophe is the standard neutraliser and is stripped by the spreadsheet on
 * display.
 */
import type { SignupRecord } from './signups';

const COLUMNS = ['email', 'intent', 'created_at', 'updated_at', 'source'] as const;

function cell(value: string | null): string {
  if (value === null || value === '') return '';
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function signupsToCsv(rows: readonly SignupRecord[]): string {
  const lines = [COLUMNS.join(',')];
  for (const row of rows) {
    lines.push([
      cell(row.email),
      cell(row.intent),
      cell(row.createdAt),
      cell(row.updatedAt),
      cell(row.source),
    ].join(','));
  }
  // Trailing CRLF: some tools drop the last line without it.
  return `${lines.join('\r\n')}\r\n`;
}

/** `sigil-signups-2026-08-19.csv` — sorts correctly in a downloads folder. */
export function csvFilename(now: Date = new Date()): string {
  return `sigil-signups-${now.toISOString().slice(0, 10)}.csv`;
}
