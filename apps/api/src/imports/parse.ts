import ExcelJS from 'exceljs';

export interface ParsedRow {
  /** Número de renglón como lo ve el usuario en Excel (1 = primer renglón). */
  rowNumber: number;
  cells: (string | null)[];
}

export interface ParsedSheet {
  sheetName: string;
  rows: ParsedRow[];
}

export class UnsupportedFileError extends Error {}

/** Quita espacios invisibles (no separables, de ancho cero, BOM) y espacios repetidos. */
export function cleanText(s: string): string | null {
  const out = s
    .replace(/[   ]/g, ' ')
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return out === '' ? null : out;
}

type CellValue = ExcelJS.CellValue;

function cellText(v: CellValue): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    // Los códigos numéricos (UPC, artículos de Liverpool) llegan como número: sin decimales ni notación científica.
    return Number.isInteger(v) ? v.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 0 }) : String(v);
  }
  if (typeof v === 'string') return cleanText(v);
  if (typeof v === 'boolean') return v ? 'SI' : 'NO';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v && Array.isArray(v.richText)) return cleanText(v.richText.map((t) => t.text).join(''));
    if ('formula' in v || 'sharedFormula' in v) return cellText((v as { result?: CellValue }).result ?? null);
    if ('hyperlink' in v && 'text' in v) return cellText((v as { text: CellValue }).text);
    if ('error' in v) return null;
  }
  return cleanText(String(v));
}

async function parseXlsx(buf: Buffer): Promise<ParsedSheet[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new UnsupportedFileError('No se pudo leer el archivo de Excel. Guárdalo como .xlsx e inténtalo de nuevo.');
  }
  const sheets: ParsedSheet[] = [];
  wb.eachSheet((ws) => {
    if (ws.state && ws.state !== 'visible') return;
    const rows: ParsedRow[] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: (string | null)[] = [];
      // Sólo las celdas con valor: algunas hojas traen formato hasta la columna XFD y recorrer todas las columnas es lentísimo.
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        const t = cellText(cell.value);
        if (t === null) return;
        while (cells.length < col - 1) cells.push(null);
        cells[col - 1] = t;
      });
      while (cells.length && cells[cells.length - 1] === null) cells.pop();
      if (cells.some((x) => x !== null)) rows.push({ rowNumber, cells });
    });
    sheets.push({ sheetName: ws.name, rows });
  });
  return sheets;
}

function decodeText(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // Excel en Windows guarda CSV en Windows-1252.
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/** CSV según RFC 4180 con detección de separador (coma, punto y coma o tabulador). */
export function parseCsvText(text: string): ParsedSheet {
  const body = text.replace(/^﻿/, '');
  const firstLine = body.split(/\r?\n/, 1)[0] ?? '';
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length] as const);
  const sep = counts.sort((a, b) => b[1] - a[1])[0][0];
  const rows: ParsedRow[] = [];
  let cells: (string | null)[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowStart = 1;
  const pushField = () => {
    cells.push(cleanText(field));
    field = '';
  };
  const pushRow = () => {
    pushField();
    while (cells.length && cells[cells.length - 1] === null) cells.pop();
    if (cells.some((c) => c !== null)) rows.push({ rowNumber: rowStart, cells });
    cells = [];
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else {
        if (ch === '\n') line++;
        field += ch;
      }
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) pushField();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++;
      pushRow();
      line++;
      rowStart = line;
    } else field += ch;
  }
  if (field !== '' || cells.length) pushRow();
  return { sheetName: 'CSV', rows };
}

export async function parseFile(buf: Buffer, fileName: string): Promise<ParsedSheet[]> {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'xlsx' || ext === 'xlsm') return parseXlsx(buf);
  if (ext === 'csv' || ext === 'txt') return [parseCsvText(decodeText(buf))];
  if (ext === 'xls') throw new UnsupportedFileError('El formato .xls (Excel 97-2003) no se admite. Guárdalo como .xlsx o .csv.');
  throw new UnsupportedFileError('Sólo se admiten archivos .xlsx o .csv.');
}

/** Normaliza encabezados para compararlos: sin acentos, mayúsculas y sin signos. */
export function normHeader(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}
