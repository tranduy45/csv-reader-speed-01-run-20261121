// A fast drop-in for csv-reader 1.0.0: run(input) returns csv-reader's reading of
// {text, header} as {columns, rows, errors}.
//
// Written from the task specification: the text is read once, left to right, with
// commas and double quotes. A U+FEFF at the very start is dropped. A record ends at
// LF or CRLF, and a line left with no characters is no record. Outside quotes a CR
// not followed by LF is dropped (error stray_cr). A field that opens with a quote
// runs to the next quote that is not doubled, "" inside it is one quote and each
// CRLF or lone CR inside it is read as LF; what follows its closing quote, up to
// the next comma or line break, is appended as it stands (quote_junk, when the
// field ends); a quote that never closes is a literal character, and the text after
// it is read again as unquoted (unterminated_quote). A quote inside an unquoted
// field is a literal character. Fields stay strings, never trimmed or converted.
// columns is the first record when header is true, else null; rows holds the
// records after it (every record when header is false), each padded with empty
// strings (short_row, with fields: its field count) or cut (long_row, with extra:
// the cut fields) to the first record's width. Each error is {code, line, row},
// in the order met, a record's short_row or long_row when it ends: line the
// 1-based line its record starts on, counting every LF, CRLF and lone CR inside
// quotes, and row its record's index in rows, null for the header.
//
// Speed comes from never reading the common case one character at a time:
// a whole record whose line holds no quote and no stray CR is split at once;
// an unquoted field is found with one regex scan to its next delimiter; a
// quoted field is found with one scan to its next quote, and only quoted fields
// that hold a line break or a doubled quote take a slower path. The rare broken
// shapes (stray CR, junk after a closing quote, a quote that never closes)
// keep the exact error order of the specification.

// The next delimiter of an unquoted field: comma, CR or LF.
const DELIM = /[,\r\n]/g;
// The next double quote.
const QUOTE = /"/g;
// The next line break (CR or LF) inside a quoted field.
const BREAK = /[\r\n]/g;

// How a field ended.
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes.
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `start` up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Returns the field and how it
  // ended; `added` counts the characters kept after `start`.
  function readUnquoted(start) {
    let value = start;
    let added = 0;
    for (;;) {
      DELIM.lastIndex = pos;
      const m = DELIM.exec(text);
      if (m === null) {
        if (pos < n) {
          if (value === '') value = text.slice(pos);
          else value += text.slice(pos);
          added += n - pos;
        }
        pos = n;
        return { value, ended: END, added };
      }
      const i = m.index;
      const c = m[0];
      if (c === ',') {
        if (value === '') value = text.slice(pos, i);
        else value += text.slice(pos, i);
        added += i - pos;
        pos = i + 1;
        return { value, ended: COMMA, added };
      }
      if (c === '\n') {
        if (value === '') value = text.slice(pos, i);
        else value += text.slice(pos, i);
        added += i - pos;
        pos = i + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      // A CR: a line break when followed by LF, a dropped stray one otherwise.
      if (text.charCodeAt(i + 1) === 10) {
        if (value === '') value = text.slice(pos, i);
        else value += text.slice(pos, i);
        added += i - pos;
        pos = i + 2;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      if (value === '') value = text.slice(pos, i);
      else value += text.slice(pos, i);
      added += i - pos;
      error('stray_cr');
      pos = i + 1;
    }
  }

  // Appends text[from..to), which holds at least one line break, to `value`,
  // reading each CRLF or lone CR inside it as one LF and counting the lines.
  function appendQuotedSpan(value, from, to) {
    let out = value;
    let p = from;
    while (p < to) {
      BREAK.lastIndex = p;
      const b = BREAK.exec(text);
      const bi = b !== null && b.index < to ? b.index : to;
      if (bi > p) out += text.slice(p, bi);
      if (bi >= to) break;
      out += '\n';
      line += 1;
      p = bi + 1;
      if (text.charCodeAt(bi) === 13 && text.charCodeAt(bi + 1) === 10) p = bi + 2;
    }
    return out;
  }

  // What follows a quoted field's closing quote: a comma, a line break, the end
  // of the text, or junk appended as it stands (quote_junk when any is kept).
  function afterClose(value) {
    if (pos >= n) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    const junk = readUnquoted(value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let value = '';
    for (;;) {
      QUOTE.lastIndex = pos;
      const m = QUOTE.exec(text);
      if (m === null) {
        // The quote never closes: it is a literal character, and the text after
        // it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      const q = m.index;
      BREAK.lastIndex = pos;
      const b = BREAK.exec(text);
      if (b !== null && b.index < q) {
        // A line break sits inside this span of the quoted field.
        value = appendQuotedSpan(value, pos, q);
        pos = q;
        if (text.charCodeAt(q + 1) === 34) {
          value += '"';
          pos = q + 2;
          continue;
        }
        pos = q + 1;
        return afterClose(value);
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one quote kept, the field goes on.
        if (value === '') value = text.slice(pos, q) + '"';
        else value += text.slice(pos, q) + '"';
        pos = q + 2;
        continue;
      }
      // A clean close with no line break inside.
      if (value === '') value = text.slice(pos, q);
      else value += text.slice(pos, q);
      pos = q + 1;
      return afterClose(value);
    }
  }

  // Finishes a record: a line left with no characters is no record; the first
  // record sets the width (and is the header when header is true); the rest are
  // padded or cut to it, with the error recorded when the record ends.
  function finishRecord(fields, lastQuoted) {
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // A whole record at once when its line holds no quote and no stray CR:
    // the record is exactly this line, split on commas.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    const qi = text.indexOf('"', pos);
    if (qi === -1 || qi >= lineEnd) {
      let contentEnd = lineEnd;
      if (nl !== -1 && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13) contentEnd = lineEnd - 1;
      const ri = text.indexOf('\r', pos);
      if (ri === -1 || ri >= contentEnd) {
        const fields = text.slice(pos, contentEnd).split(',');
        if (nl === -1) {
          pos = n;
        } else {
          pos = nl + 1;
          line += 1;
        }
        finishRecord(fields, false);
        continue;
      }
    }

    // Otherwise, field by field.
    const fields = [];
    let lastQuoted = false;
    let ended;
    do {
      if (text.charCodeAt(pos) === 34) {
        lastQuoted = true;
        const field = readQuoted();
        fields.push(field.value);
        ended = field.ended;
      } else {
        lastQuoted = false;
        const field = readUnquoted('');
        fields.push(field.value);
        ended = field.ended;
      }
    } while (ended === COMMA);
    finishRecord(fields, lastQuoted);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
