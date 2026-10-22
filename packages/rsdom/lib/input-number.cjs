'use strict';
// Numeric and date inputs (ROADMAP Stage 3 `forms`, DESIGN §36): `valueAsNumber` / `valueAsDate` setters and
// `stepUp()` / `stepDown()`, ported from jsdom 30 (refs/jsdom/lib/jsdom/living/nodes/HTMLInputElement-impl.js and
// helpers/number-and-date-inputs.js). Parsing a value string by type is Rust's (`formNumber`, the same
// conversion `valueAsNumber` and validity use); what stays here is jsdom's Decimal stepping and the
// number-to-string serializers, whose result Rust stores as the raw value (`valueSetRaw`, jsdom's `#setValue`).

let Decimal; // decimal.js, loaded on the first step (startup cost, DESIGN §15.2)
const rt = require('./runtime.cjs');

const { N } = rt;

const NUMERIC = new Set(['date', 'month', 'week', 'time', 'datetime-local', 'number', 'range']);
const DATE_TYPES = new Set(['date', 'month', 'week', 'time']);
const DAY = 86_400_000;

/** `type`'s value string as a number (null: not a valid string for the type). */
function toNumber(type, s) {
  if (s === null) return null;
  const n = N.formNumber(type, s);
  return Number.isNaN(n) ? null : n;
}

const pad = (v, w) => String(v).padStart(w, '0');

function serializeTime(d) {
  const [h, m, s, ms] = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()];
  let out = `${pad(h, 2)}:${pad(m, 2)}`;
  if (s === 0 && ms === 0) return out;
  out += `:${pad(s, 2)}`;
  return ms === 0 ? out : `${out}.${pad(ms, 3).replace(/0+$/u, '')}`;
}

const serializeDate = (d) => `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
const serializeMonth = (d) => `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}`;

/** jsdom `parseDateAsWeek` (ISO week of a UTC date). */
function serializeWeek(original) {
  const d = new Date(Date.UTC(original.getUTCFullYear(), original.getUTCMonth(), original.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / DAY + 1) / 7);
  return `${pad(d.getUTCFullYear(), 4)}-W${pad(week, 2)}`;
}

/** jsdom `serializeDateByType` (a Date's UTC fields as the type's value string). */
const DATE_TO_STRING = {
  date: serializeDate,
  month: serializeMonth,
  week: serializeWeek,
  time: serializeTime,
  'datetime-local': (d) => (Number.isNaN(d.getTime()) ? '' : `${serializeDate(d)}T${serializeTime(d)}`),
};

/** jsdom `convertNumberToStringByType`. */
function numberToString(type, n) {
  switch (type) {
    case 'number':
    case 'range':
      return n.toString();
    case 'month': {
      const d = new Date(0);
      d.setUTCFullYear(1970 + Math.floor(n / 12));
      d.setUTCMonth(n % 12);
      return serializeMonth(d);
    }
    case 'time':
      return serializeTime(new Date(((n % DAY) + DAY) % DAY));
    default:
      return DATE_TO_STRING[type](new Date(n));
  }
}

/** jsdom `convertStringToDateByType` (month: the first of the month at UTC midnight). */
function stringToDate(type, s) {
  const n = toNumber(type, s);
  if (n === null) return null;
  if (type !== 'month') return new Date(n);
  const d = new Date(0);
  d.setUTCFullYear(1970 + Math.floor(n / 12));
  d.setUTCMonth(((n % 12) + 12) % 12);
  return d;
}

/** The element's `[stepScaleFactor, defaultStep]`. */
function stepScale(type) {
  if (type === 'week') return [7 * DAY, 1];
  if (type === 'date') return [DAY, 1];
  if (type === 'datetime-local' || type === 'time') return [1000, 60];
  return [1, 1];
}

/** jsdom `parseFloatingPointNumber`: `parseFloat` after ASCII whitespace only; null unless finite. */
function parseFloatingPoint(s) {
  const lead = s.length - s.trimStart().length;
  if (/[^\t\n\f\r ]/.test(s.slice(0, lead))) return null;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

/** jsdom `_allowedValueStep` (null: "any"). */
function allowedStep(el, type) {
  const [scale, dflt] = stepScale(type);
  const attr = el.getAttribute('step');
  if (attr === null) return dflt * scale;
  if (rt.asciiLower(attr) === 'any') return null;
  const v = parseFloatingPoint(attr);
  return v === null || v <= 0 ? dflt * scale : v * scale;
}

function minimum(el, type) {
  return toNumber(type, el.getAttribute('min')) ?? (type === 'range' ? 0 : null);
}

function maximum(el, type) {
  return toNumber(type, el.getAttribute('max')) ?? (type === 'range' ? 100 : null);
}

/** jsdom `_stepBase`. */
function stepBase(el, type) {
  return toNumber(type, el.getAttribute('min')) ?? toNumber(type, el.getAttribute('value')) ?? (type === 'week' ? -259_200_000 : 0);
}

/** jsdom `#setValue`: the raw value, without the setter's sanitization or dirty flag (React's value tracker
 * never sees it, so a following input event reaches onChange, as in jsdom). */
function setRaw(el, v) {
  N.valueSetRaw(el._i, v);
  rt.mutated();
}

function stepAlign(v, step, base, up) {
  return new Decimal(v).minus(base).toNearest(step, up ? Decimal.ROUND_UP : Decimal.ROUND_DOWN).add(base);
}

/** `stepUp(n)` / `stepDown(n)` (jsdom `_stepUpdate`). */
function stepUpdate(el, type, n, isUp) {
  const name = isUp ? 'stepUp' : 'stepDown';
  Decimal ??= require('decimal.js'); // eslint-disable-line global-require
  if (!NUMERIC.has(type)) {
    throw rt.domError(6, `Failed to invoke '${name}' method on 'HTMLInputElement': This input element does not support Number values.`);
  }
  const step = allowedStep(el, type);
  if (step === null) {
    throw rt.domError(6, `Failed to invoke '${name}' method on 'HTMLInputElement': This input element does not support value step.`);
  }
  const base = stepBase(el, type);
  const min = minimum(el, type);
  const max = maximum(el, type);
  if (min !== null && max !== null) {
    if (min > max) return;
    const candidate = stepAlign(Decimal.add(min, step), step, base, false);
    if (candidate.lt(min) || candidate.gt(max)) return;
  }
  let value = el.valueAsNumber;
  if (Number.isNaN(value)) value = 0;
  value = new Decimal(value);
  const before = value;
  if (!value.minus(base).modulo(step).isZero()) {
    value = stepAlign(value, step, base, isUp);
  } else {
    const delta = Decimal.mul(n, step);
    value = value.add(isUp ? delta : delta.neg());
  }
  if (min !== null && value.lt(min)) value = stepAlign(min, step, base, true);
  if (max !== null && value.gt(max)) value = stepAlign(max, step, base, false);
  if (isUp ? value.lt(before) : value.gt(before)) return;
  setRaw(el, numberToString(type, value.toNumber()));
}

const dateToString = (type, d) => DATE_TO_STRING[type](d);

module.exports = { setRaw, NUMERIC, DATE_TYPES, numberToString, dateToString, stringToDate, stepUpdate, parseFloatingPoint };
