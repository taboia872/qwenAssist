/* qwenAssist — timezone spoXf (IANA-aware, DST-correct, full Date surface).
 *
 * Ported from deafenken/notme (lib/timezone.js + content-inject.js installTimezone
 * + installDateConstructor). Geolocation, locale, workers, font-hiding stripped.
 *
 * Payload arrives as window.__TA_SETTINGS__ { timezone, tzEnabled } injected by
 * the Android host before this script runs. The IANA timezone drives every
 * Date local-time surface so no method contradicts another; DST is handled by
 * Intl.DateTimeFormat('en-US', {timeZone:...}).formatToParts().
 */
(function () {
  'use strict';

  // Pull in settings injected by the host. Defaults keep the script inert.
  var S = window.__TA_SETTINGS__ || {};
  // Delete so a page can't probe it.
  try { delete window.__TA_SETTINGS__; } catch (_) {}

  // Only proceed when the host genuinely enabled tz spoofing.
  if (!S.tzEnabled || !S.timezone) return;

  var TZ_NAME = S.timezone;

  // -----------------------------------------------------------------------
  // Capture pristine natives BEFORE shadowing anything.
  // -----------------------------------------------------------------------
  var RealDate = Date;
  var D = Date.prototype;
  var realGetTime = D.getTime;
  var realSetTime = D.setTime;
  var realParse = Date.parse;
  var realDateToString = D.toString;
  var realDateToDateString = D.toDateString;
  var realDateToTimeString = D.toTimeString;
  var realDateToLocaleString = D.toLocaleString;
  var realDateToLocaleDateString = D.toLocaleDateString;
  var realDateToLocaleTimeString = D.toLocaleTimeString;
  var realGetTZO = D.getTimezoneOffset;
  var realLocalGetters = {
    getFullYear: D.getFullYear, getMonth: D.getMonth, getDate: D.getDate,
    getDay: D.getDay, getHours: D.getHours, getMinutes: D.getMinutes,
    getSeconds: D.getSeconds, getMilliseconds: D.getMilliseconds, getYear: D.getYear,
  };
  var realLocalSetters = {
    setFullYear: D.setFullYear, setMonth: D.setMonth, setDate: D.setDate,
    setHours: D.setHours, setMinutes: D.setMinutes, setSeconds: D.setSeconds,
    setMilliseconds: D.setMilliseconds, setYear: D.setYear,
  };
  var realDTF = Intl.DateTimeFormat;

  // -----------------------------------------------------------------------
  // IANA DST-aware offset helpers (from notme lib/timezone.js).
  // -----------------------------------------------------------------------
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // Memoize the (stateless) formatters so we don't build one per getHours().
  var _offsetFmt = null;
  var _nameFmtLong = null;
  var _nameFmtShort = null;
  function offsetFormatter() {
    if (_offsetFmt) return _offsetFmt;
    _offsetFmt = new realDTF('en-US', {
      timeZone: TZ_NAME, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    return _offsetFmt;
  }
  function nameFormatter(style) {
    var f = (style === 'short') ? _nameFmtShort : _nameFmtLong;
    if (f) return f;
    f = new realDTF('en-US', { timeZone: TZ_NAME, hour: '2-digit', hour12: false, timeZoneName: style });
    if (style === 'short') _nameFmtShort = f; else _nameFmtLong = f;
    return f;
  }

  function validDateOrNow(date) {
    if (date instanceof RealDate && Number.isFinite(date.getTime())) return date;
    return new RealDate();
  }

  // JS sign convention: getTimezoneOffset returns UTC - local in minutes.
  // UTC+9 => -540, UTC-7 => +420.
  function tzOffsetMinutes(timeZone, date) {
    try {
      var instant = validDateOrNow(date);
      var parts = offsetFormatter().formatToParts(instant).reduce(function (acc, p) {
        acc[p.type] = p.value; return acc;
      }, {});
      var hour = parts.hour;
      if (hour === '24') hour = '00';
      var wallAsUtc = RealDate.UTC(
        Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(hour), Number(parts.minute), Number(parts.second)
      );
      var offset = -Math.round((wallAsUtc - instant.getTime()) / 60000);
      return Object.is(offset, -0) ? 0 : offset;
    } catch (_) { return null; }
  }

  // Wall-clock components of `date` as seen in `timeZone` (month 0-11, Sun=0).
  function wallClock(timeZone, date) {
    var d = validDateOrNow(date);
    var off = tzOffsetMinutes(timeZone, d);
    if (off == null) return null;
    var shifted = new RealDate(d.getTime() - off * 60000);
    return {
      year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(),
      day: shifted.getUTCDate(), hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(), second: shifted.getUTCSeconds(),
      ms: shifted.getUTCMilliseconds(), weekday: shifted.getUTCDay(),
    };
  }

  // Inverse: wall-clock components in `timeZone` -> UTC epoch ms, DST-aware.
  function localWallToEpoch(timeZone, y, mo, d, h, mi, s, ms) {
    var e0 = RealDate.UTC(y, mo, d, h || 0, mi || 0, s || 0, ms || 0);
    var offBefore = tzOffsetMinutes(timeZone, new RealDate(e0 - 86400000));
    var offAfter = tzOffsetMinutes(timeZone, new RealDate(e0 + 86400000));
    if (offBefore == null && offAfter == null) return e0;
    if (offBefore == null) return e0 + offAfter * 60000;
    if (offAfter == null || offBefore === offAfter) return e0 + offBefore * 60000;
    var candA = e0 + offBefore * 60000;
    if (tzOffsetMinutes(timeZone, new RealDate(candA)) === offBefore) return candA;
    var candB = e0 + offAfter * 60000;
    if (tzOffsetMinutes(timeZone, new RealDate(candB)) === offAfter) return candB;
    return candA; // spring-forward gap: pre-transition offset
  }

  function tzName(timeZone, date, style) {
    try {
      var part = nameFormatter(style || 'long').formatToParts(validDateOrNow(date))
        .find(function (p) { return p.type === 'timeZoneName'; });
      return part ? part.value : '';
    } catch (_) { return ''; }
  }

  // offset -540 (UTC+9) => "GMT+0900"
  function formatGMT(offsetMinutes) {
    var real = -offsetMinutes;
    var sign = real >= 0 ? '+' : '-';
    var abs = Math.abs(real);
    return 'GMT' + sign + pad2(Math.floor(abs / 60)) + pad2(abs % 60);
  }

  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function nativeDateStrings(timeZone, date) {
    var w = wallClock(timeZone, date);
    if (!w) return null;
    var off = tzOffsetMinutes(timeZone, date);
    var datePart = WEEKDAYS[w.weekday] + ' ' + MONTHS[w.month] + ' ' + pad2(w.day) + ' ' + w.year;
    var timePart = pad2(w.hour) + ':' + pad2(w.minute) + ':' + pad2(w.second) + ' '
      + formatGMT(off) + ' (' + tzName(timeZone, date, 'long') + ')';
    return { date: datePart, time: timePart };
  }

  // -----------------------------------------------------------------------
  // Install Date.prototype overrides — full local-time surface.
  // -----------------------------------------------------------------------
  function tzActive() { return true; } // gated at top of file already

  // getTimezoneOffset
  try {
    D.getTimezoneOffset = function getTimezoneOffset() {
      if (Number.isFinite(realGetTime.call(this))) {
        var off = tzOffsetMinutes(TZ_NAME, this);
        if (off != null) return off;
      }
      return realGetTZO.call(this);
    };
  } catch (_) {}

  // Local getters -> wall clock in the spoofed zone.
  var getterField = {
    getFullYear: 'year', getMonth: 'month', getDate: 'day', getDay: 'weekday',
    getHours: 'hour', getMinutes: 'minute', getSeconds: 'second', getMilliseconds: 'ms',
  };
  Object.keys(getterField).forEach(function (name) {
    var field = getterField[name];
    var real = realLocalGetters[name];
    try {
      D[name] = function () {
        if (Number.isFinite(realGetTime.call(this))) {
          var w = wallClock(TZ_NAME, this);
          if (w) return w[field];
        }
        return real.call(this);
      };
    } catch (_) {}
  });
  // getYear (deprecated: getFullYear() - 1900)
  try {
    D.getYear = function () {
      if (Number.isFinite(realGetTime.call(this))) {
        var w = wallClock(TZ_NAME, this);
        if (w) return w.year - 1900;
      }
      return realLocalGetters.getYear.call(this);
    };
  } catch (_) {}

  // Local setters -> interpret args as wall clock in the spoofed zone.
  function makeSetter(name, apply) {
    var real = realLocalSetters[name];
    try {
      D[name] = function () {
        if (!Number.isFinite(realGetTime.call(this))) return real.apply(this, arguments);
        var w = wallClock(TZ_NAME, this);
        if (!w) return real.apply(this, arguments);
        apply(w, arguments);
        var epoch = localWallToEpoch(TZ_NAME, w.year, w.month, w.day, w.hour, w.minute, w.second, w.ms);
        return realSetTime.call(this, epoch);
      };
    } catch (_) {}
  }
  makeSetter('setFullYear', function (w, a) { w.year = +a[0]; if (a.length > 1) w.month = +a[1]; if (a.length > 2) w.day = +a[2]; });
  makeSetter('setMonth',     function (w, a) { w.month = +a[0]; if (a.length > 1) w.day = +a[1]; });
  makeSetter('setDate',      function (w, a) { w.day = +a[0]; });
  makeSetter('setHours',     function (w, a) { w.hour = +a[0]; if (a.length > 1) w.minute = +a[1]; if (a.length > 2) w.second = +a[2]; if (a.length > 3) w.ms = +a[3]; });
  makeSetter('setMinutes',   function (w, a) { w.minute = +a[0]; if (a.length > 1) w.second = +a[1]; if (a.length > 2) w.ms = +a[2]; });
  makeSetter('setSeconds',   function (w, a) { w.second = +a[0]; if (a.length > 1) w.ms = +a[1]; });
  makeSetter('setMilliseconds', function (w, a) { w.ms = +a[0]; });
  makeSetter('setYear',      function (w, a) { var y = +a[0]; if (y >= 0 && y <= 99) y += 1900; w.year = y; });

  // toString / toDateString / toTimeString rebuilt in the spoofed zone.
  function dateStringWrapper(name, real, pick) {
    try {
      D[name] = function () {
        if (Number.isFinite(realGetTime.call(this))) {
          var s = nativeDateStrings(TZ_NAME, this);
          if (s) return pick(s);
        }
        return real.call(this);
      };
    } catch (_) {}
  }
  dateStringWrapper('toString', realDateToString, function (s) { return s.date + ' ' + s.time; });
  dateStringWrapper('toDateString', realDateToDateString, function (s) { return s.date; });
  dateStringWrapper('toTimeString', realDateToTimeString, function (s) { return s.time; });

  // toLocale* — inject timeZone into options (inheritance-safe, don't mutate caller).
  function makeDateToLocale(real, name) {
    try {
      D[name] = function (locales, options) {
        if (!Number.isFinite(realGetTime.call(this))) return real.call(this, locales, options);
        var opts = (options && typeof options === 'object') ? Object.create(options) : {};
        if (opts.timeZone === undefined) opts.timeZone = TZ_NAME;
        return real.call(this, locales, opts);
      };
    } catch (_) {}
  }
  makeDateToLocale(realDateToLocaleString, 'toLocaleString');
  makeDateToLocale(realDateToLocaleDateString, 'toLocaleDateString');
  makeDateToLocale(realDateToLocaleTimeString, 'toLocaleTimeString');

  // -----------------------------------------------------------------------
  // Replace the global Date constructor (numeric multi-arg, offset-less
  // string parse, Date() called as a function).
  // -----------------------------------------------------------------------
  function parseOffsetlessLocal(str) {
    var m = /^\s*(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*$/.exec(str);
    if (!m) return null;
    var mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], se = +(m[6] || 0);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
    var ms = m[7] ? Number((m[7] + '00').slice(0, 3)) : 0;
    return localWallToEpoch(TZ_NAME, +m[1], mo - 1, d, h, mi, se, ms);
  }
  function adjustArgs(args) {
    try {
      if (args.length >= 2) {
        var y = +args[0];
        if (y >= 0 && y <= 99) y += 1900;
        var epoch = localWallToEpoch(TZ_NAME, y, +args[1],
          args.length > 2 ? +args[2] : 1, args.length > 3 ? +args[3] : 0,
          args.length > 4 ? +args[4] : 0, args.length > 5 ? +args[5] : 0,
          args.length > 6 ? +args[6] : 0);
        return [epoch];
      }
      if (args.length === 1 && typeof args[0] === 'string') {
        var epoch = parseOffsetlessLocal(args[0]);
        if (epoch != null) return [epoch];
      }
    } catch (_) {}
    return args;
  }

  if (typeof Reflect !== 'undefined' && Reflect.construct) {
    var DateProxy = function Date() {
      if (!new.target) {
        // Date() as a function returns current time as a string, ignoring args.
        var s = nativeDateStrings(TZ_NAME, new RealDate());
        if (s) return s.date + ' ' + s.time;
        return realDateToString.call(new RealDate());
      }
      return Reflect.construct(RealDate, adjustArgs(arguments), new.target);
    };
    DateProxy.now = RealDate.now;     // natives — untouched
    DateProxy.UTC = RealDate.UTC;
    DateProxy.parse = function (str) {
      if (typeof str === 'string') {
        try { var e = parseOffsetlessLocal(str); if (e != null) return e; } catch (_) {}
      }
      return realParse.call(RealDate, str);
    };
    try { DateProxy.prototype = RealDate.prototype; } catch (_) {}
    try { Object.defineProperty(RealDate.prototype, 'constructor', { value: DateProxy, configurable: true, writable: true }); } catch (_) {}
    try { Date = DateProxy; } catch (_) {}
    try { window.Date = DateProxy; } catch (_) {}
  }

  // -----------------------------------------------------------------------
  // Intl.DateTimeFormat — inject our timezone when caller didn't set one.
  // -----------------------------------------------------------------------
  var wrappedDTF = function DateTimeFormat() {
    var locale = arguments[0];
    var options = arguments[1];
    var opts = (options && typeof options === 'object') ? Object.create(options) : {};
    if (opts.timeZone === undefined) opts.timeZone = TZ_NAME;
    if (new.target) return Reflect.construct(realDTF, [locale, opts], new.target);
    return realDTF(locale, opts);
  };
  try { wrappedDTF.prototype = realDTF.prototype; } catch (_) {}
  try { Object.defineProperty(realDTF.prototype, 'constructor', { value: wrappedDTF, configurable: true, writable: true }); } catch (_) {}
  if (realDTF.supportedLocalesOf) wrappedDTF.supportedLocalesOf = realDTF.supportedLocalesOf.bind(realDTF);
  try { Intl.DateTimeFormat = wrappedDTF; } catch (_) {}
})();
