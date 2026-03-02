import {logger} from "firebase-functions/v2";
import {PDFParse} from "pdf-parse";
import mammoth from "mammoth";
import * as XLSX from "xlsx";

// Supported document MIME types
const DOCUMENT_MIME_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
  "text/csv": "csv",
  "text/plain": "txt",
};

/**
 * Parse a PDF file, extracting text from the first 2 pages
 */
async function parsePDF(buffer: Buffer, maxChars: number): Promise<string> {
  const parser = new PDFParse({data: buffer});
  const result = await parser.getText({first: 2});
  await parser.destroy();
  return result.text.slice(0, maxChars);
}

/**
 * Parse a DOCX file, extracting raw text
 */
async function parseDOCX(buffer: Buffer, maxChars: number): Promise<string> {
  const result = await mammoth.extractRawText({buffer});
  return result.value.slice(0, maxChars);
}

/**
 * Parse an Excel file, converting first 2 sheets to CSV text
 */
function parseExcel(buffer: Buffer, maxChars: number, maxCharsPerSheet: number): string {
  const workbook = XLSX.read(buffer, {sheets: [0, 1]});
  const sheets = workbook.SheetNames.slice(0, 2);
  return sheets.map((name) => {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
    return `## Sheet: ${name}\n${csv.slice(0, maxCharsPerSheet)}`;
  }).join("\n\n").slice(0, maxChars);
}

/**
 * Parse a CSV file
 */
function parseCSV(buffer: Buffer, maxChars: number): string {
  return buffer.toString("utf-8").slice(0, maxChars);
}

/**
 * Parse a plain text file
 */
function parseTXT(buffer: Buffer, maxChars: number): string {
  return buffer.toString("utf-8").slice(0, maxChars);
}

/**
 * Route to the appropriate parser based on document type
 */
async function parseDocument(
    buffer: Buffer,
    docType: string,
    maxChars: number,
    maxCharsPerSheet: number = maxChars,
): Promise<string> {
  switch (docType) {
    case "pdf":
      return parsePDF(buffer, maxChars);
    case "docx":
      return parseDOCX(buffer, maxChars);
    case "xlsx":
    case "xls":
      return parseExcel(buffer, maxChars, maxCharsPerSheet);
    case "csv":
      return parseCSV(buffer, maxChars);
    case "txt":
      return parseTXT(buffer, maxChars);
    default:
      logger.warn(`Unsupported document type: ${docType}`);
      return "";
  }
}

export {
  DOCUMENT_MIME_TYPES,
  parsePDF,
  parseDOCX,
  parseExcel,
  parseCSV,
  parseTXT,
  parseDocument,
};
