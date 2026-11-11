// A minimal .xlsx writer.
//
// CSV cannot carry column widths, wrapping, row heights or frozen panes — it is
// plain text — so an exported sheet always opened with 8-character columns,
// dates rendered as ######, and one 500px-tall row wherever a booking's notes
// contained line breaks. Fixing that needs a real workbook.
//
// This is hand-rolled rather than pulled from a library on purpose. The
// community build of SheetJS cannot write cell styles (so no bold header, no
// wrapping), and ExcelJS expects Node streams and a zlib it will not find in a
// Worker. What we actually need is a narrow slice of the format — one sheet of
// strings, column widths, a frozen bold header, autofilter and wrapping — and
// that slice is small enough to own.
//
// An .xlsx is a ZIP of XML. Entries are STORED (uncompressed), which is valid
// and means no deflate implementation is required; the files are small and this
// is generated per request.

function crc32(bytes: Uint8Array): number {
  let c = ~0
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return ~c >>> 0
}

type ZipEntry = { name: string; data: Uint8Array }

// ZIP with stored entries. Local header + central directory + EOCD, no
// compression, no data descriptors, no zip64 — the sheets we write are far
// under any of those limits.
function zipStore(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const e of entries) {
    const nameBytes = enc.encode(e.name)
    const crc = crc32(e.data)

    const local = new Uint8Array(30 + nameBytes.length + e.data.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)   // local file header signature
    lv.setUint16(4, 20, true)           // version needed
    lv.setUint16(6, 0, true)            // flags
    lv.setUint16(8, 0, true)            // method: stored
    lv.setUint16(10, 0, true)           // mod time
    lv.setUint16(12, 0x21, true)        // mod date (1996-01-01; arbitrary but valid)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, e.data.length, true)
    lv.setUint32(22, e.data.length, true)
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true)           // extra field length
    local.set(nameBytes, 30)
    local.set(e.data, 30 + nameBytes.length)
    locals.push(local)

    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)   // central directory signature
    cv.setUint16(4, 20, true)           // version made by
    cv.setUint16(6, 20, true)           // version needed
    cv.setUint16(8, 0, true)
    cv.setUint16(10, 0, true)           // stored
    cv.setUint16(12, 0, true)
    cv.setUint16(14, 0x21, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, e.data.length, true)
    cv.setUint32(24, e.data.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true)           // extra
    cv.setUint16(32, 0, true)           // comment
    cv.setUint16(34, 0, true)           // disk number
    cv.setUint16(36, 0, true)           // internal attrs
    cv.setUint32(38, 0, true)           // external attrs
    cv.setUint32(42, offset, true)      // offset of local header
    central.set(nameBytes, 46)
    centrals.push(central)

    offset += local.length
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  const total = offset + centralSize + eocd.length
  const out = new Uint8Array(total)
  let p = 0
  for (const b of locals)   { out.set(b, p); p += b.length }
  for (const b of centrals) { out.set(b, p); p += b.length }
  out.set(eocd, p)
  return out
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Excel rejects most control characters outright. Tabs and newlines are
    // legal inside a cell; the rest would make the file unopenable.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
}

// 0-based column index -> A, B, ... Z, AA, AB ...
function colName(i: number): string {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  }
  return s
}

export type SheetColumn = {
  header: string
  width: number
  wrap?: boolean
}

// Style indices into cellXfs below. Kept as named constants because a wrong
// number here is invisible until someone opens the file.
const STYLE_HEADER = 1
const STYLE_CELL   = 2
const STYLE_WRAP   = 3

export function buildXlsx(sheetName: string, columns: SheetColumn[], rows: string[][]): Uint8Array {
  const enc = new TextEncoder()
  const lastCol = colName(columns.length - 1)
  const lastRow = rows.length + 1

  const cols = columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`)
    .join('')

  const cell = (r: number, i: number, text: string, style: number) =>
    `<c r="${colName(i)}${r}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${esc(text)}</t></is></c>`

  const headerRow =
    `<row r="1">${columns.map((c, i) => cell(1, i, c.header, STYLE_HEADER)).join('')}</row>`

  const bodyRows = rows.map((row, ri) => {
    const r = ri + 2
    const cells = columns
      .map((c, i) => cell(r, i, row[i] ?? '', c.wrap ? STYLE_WRAP : STYLE_CELL))
      .join('')
    return `<row r="${r}">${cells}</row>`
  }).join('')

  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    // Freeze the header so it stays put while scrolling 900 bookings.
    `<sheetViews><sheetView workbookViewId="0">` +
    `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
    `<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>` +
    `</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    `<cols>${cols}</cols>` +
    `<sheetData>${headerRow}${bodyRows}</sheetData>` +
    `<autoFilter ref="A1:${lastCol}${lastRow}"/>` +
    `</worksheet>`

  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="2">` +
      `<font><sz val="11"/><name val="Calibri"/></font>` +
      `<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>` +
    `</fonts>` +
    // Index 0 and 1 are reserved by the format (none, gray125); the header fill
    // has to be index 2 or later or Excel ignores it.
    `<fills count="3">` +
      `<fill><patternFill patternType="none"/></fill>` +
      `<fill><patternFill patternType="gray125"/></fill>` +
      `<fill><patternFill patternType="solid"><fgColor rgb="FFBC002D"/><bgColor indexed="64"/></patternFill></fill>` +
    `</fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="4">` +
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
      `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>` +
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>` +
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
    `</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `</Types>`

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${esc(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets>` +
    `</workbook>`

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`

  return zipStore([
    { name: '[Content_Types].xml',       data: enc.encode(contentTypes) },
    { name: '_rels/.rels',               data: enc.encode(rootRels) },
    { name: 'xl/workbook.xml',           data: enc.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRels) },
    { name: 'xl/styles.xml',             data: enc.encode(styles) },
    { name: 'xl/worksheets/sheet1.xml',  data: enc.encode(sheet) },
  ])
}
