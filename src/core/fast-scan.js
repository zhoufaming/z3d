/**
 * 高性能字符扫描工具。
 *
 * 3MF 的 <vertices>/<triangles> 节点动辄几十万条，用 DOMParser 或全局正则
 * 会产生海量临时字符串与对象，是解析大模型时的主要瓶颈。
 * 这里直接按字符码扫描，配合 TypedArray 写入，避免中间分配。
 */

// 扫描器共享游标，避免每次解析数字都分配返回数组
let cursor = 0;

export function getCursor() {
  return cursor;
}

const CH_0 = 48;
const CH_9 = 57;
const CH_MINUS = 45;
const CH_PLUS = 43;
const CH_DOT = 46;
const CH_e = 101;
const CH_E = 69;

/**
 * 从 pos 开始跳过非数字字符，解析一个十进制浮点数（支持科学计数法）。
 * 解析结束后 cursor 指向数字之后的第一个字符。
 * 找不到数字时返回 NaN。
 */
export function scanFloat(s, pos, end) {
  const limit = end === undefined ? s.length : end;
  let i = pos;

  // 定位数字起点
  while (i < limit) {
    const c = s.charCodeAt(i);
    if ((c >= CH_0 && c <= CH_9) || c === CH_MINUS || c === CH_DOT || c === CH_PLUS) break;
    i++;
  }
  if (i >= limit) {
    cursor = limit;
    return NaN;
  }

  const start = i;
  let neg = false;
  let c = s.charCodeAt(i);
  if (c === CH_MINUS) {
    neg = true;
    i++;
  } else if (c === CH_PLUS) {
    i++;
  }

  let intPart = 0;
  let sawDigit = false;
  while (i < limit) {
    c = s.charCodeAt(i);
    if (c < CH_0 || c > CH_9) break;
    intPart = intPart * 10 + (c - CH_0);
    sawDigit = true;
    i++;
  }

  let value = intPart;
  if (i < limit && s.charCodeAt(i) === CH_DOT) {
    i++;
    let frac = 0;
    let scale = 1;
    while (i < limit) {
      c = s.charCodeAt(i);
      if (c < CH_0 || c > CH_9) break;
      frac = frac * 10 + (c - CH_0);
      scale *= 10;
      sawDigit = true;
      i++;
    }
    value += frac / scale;
  }

  if (!sawDigit) {
    // 例如遇到孤立的 '-' 或 '.'，回退用原生解析兜底
    cursor = start + 1;
    return NaN;
  }

  if (i < limit) {
    c = s.charCodeAt(i);
    if (c === CH_e || c === CH_E) {
      // 科学计数法比较罕见，交给原生解析，正确性优先
      let j = i + 1;
      if (j < limit) {
        const sc = s.charCodeAt(j);
        if (sc === CH_MINUS || sc === CH_PLUS) j++;
      }
      let expDigits = 0;
      while (j < limit) {
        const ec = s.charCodeAt(j);
        if (ec < CH_0 || ec > CH_9) break;
        expDigits++;
        j++;
      }
      if (expDigits > 0) {
        const parsed = parseFloat(s.slice(start, j));
        cursor = j;
        return parsed;
      }
    }
  }

  cursor = i;
  return neg ? -value : value;
}

/** 解析无符号整数，语义同 scanFloat */
export function scanInt(s, pos, end) {
  const limit = end === undefined ? s.length : end;
  let i = pos;
  while (i < limit) {
    const c = s.charCodeAt(i);
    if ((c >= CH_0 && c <= CH_9) || c === CH_MINUS) break;
    i++;
  }
  if (i >= limit) {
    cursor = limit;
    return NaN;
  }
  let neg = false;
  if (s.charCodeAt(i) === CH_MINUS) {
    neg = true;
    i++;
  }
  let v = 0;
  let sawDigit = false;
  while (i < limit) {
    const c = s.charCodeAt(i);
    if (c < CH_0 || c > CH_9) break;
    v = v * 10 + (c - CH_0);
    sawDigit = true;
    i++;
  }
  cursor = i;
  if (!sawDigit) return NaN;
  return neg ? -v : v;
}

/**
 * 读取形如 attr="value" 的属性值（字符串原样返回，不做实体反转义）。
 * 只在 [from, to) 范围内查找，找不到返回 null。
 */
export function readAttr(s, name, from, to) {
  const limit = to === undefined ? s.length : to;
  const needle = name + '="';
  const idx = s.indexOf(needle, from);
  if (idx === -1 || idx >= limit) return null;
  const start = idx + needle.length;
  const endQuote = s.indexOf('"', start);
  if (endQuote === -1 || endQuote > limit) return null;
  return s.slice(start, endQuote);
}

/** XML 文本反转义 */
export function unescapeXml(str) {
  if (str == null) return str;
  if (str.indexOf('&') === -1) return str;
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

/** XML 文本转义 */
export function escapeXml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 数字序列化：去掉无意义的小数尾巴，控制文件体积 */
export function fmtNum(n, precision = 6) {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  let s = n.toFixed(precision);
  // 去掉末尾的 0 和小数点
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}
