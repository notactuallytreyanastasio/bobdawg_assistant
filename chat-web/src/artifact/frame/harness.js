// The frame's side of the conversation with the page. It runs after the lockdown and before
// any model code, so what it needs is captured here, before that code can rewrite it. Model
// code can still forge any message, which is why the page treats all of this as claims.
(function () {
  var HEARTBEAT_MS = 250;
  var SETTLE_MS = 1200;
  var ERRORS_KEPT = 20;
  var LOGS_KEPT = 20;
  var REPORT_TEXT_CHARS = 300;
  var MARKS_ENOUGH = 50;
  var TITLE_LINES = 2;
  var SHAPES = 'rect,circle,ellipse,path,line,polygon,polyline';
  var NOT_DATA = '.tick,.domain,defs,clipPath,marker,pattern,mask,symbol';

  var apply = Reflect.apply;
  var target = parent;
  var post = target.postMessage;
  var later = setTimeout;
  var every = setInterval;
  var Str = String;
  var Observer = ResizeObserver;
  var root = document.getElementById('root');
  var sent = { error: 0, log: 0 };

  function send(message) {
    apply(post, target, [message, '*']);
  }

  // Past the number the page keeps, sending more only spends the message budget, and a chart
  // logging every row should not be mistaken for a flood.
  function sendCounted(kind, message) {
    if (sent[kind] >= (kind === 'error' ? ERRORS_KEPT : LOGS_KEPT)) return;
    sent[kind] += 1;
    send(message);
  }

  function lineOf(stack) {
    var found = /about:srcdoc:(\d+)/.exec(Str(stack));
    return found === null ? null : Number(found[1]);
  }

  function textOf(values) {
    var parts = [];
    for (var i = 0; i < values.length; i += 1) {
      var value = values[i];
      var shown;
      try {
        shown = typeof value === 'object' && value !== null ? JSON.stringify(value) : Str(value);
      } catch (reason) {
        shown = Str(value);
      }
      parts.push(shown);
    }
    return parts.join(' ');
  }

  send({ kind: 'alive' });
  apply(every, window, [function () { send({ kind: 'alive' }); }, HEARTBEAT_MS]);

  addEventListener('error', function (event) {
    sendCounted('error', { kind: 'error', message: Str(event.message), line: event.lineno || null });
  });

  addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    var message = reason && reason.message ? reason.message : reason;
    sendCounted('error', { kind: 'error', message: Str(message), line: lineOf(reason && reason.stack) });
  });

  // The address is left out on purpose: it is where a stolen value would be.
  addEventListener('securitypolicyviolation', function (event) {
    sendCounted('error', { kind: 'error', message: 'the sandbox refused this: ' + event.violatedDirective, line: null });
  });

  ['log', 'error'].forEach(function (name) {
    var original = console[name];
    console[name] = function () {
      sendCounted('log', { kind: 'log', text: textOf(arguments) });
      return apply(original, console, arguments);
    };
  });

  // The root rather than the document: a document's scroll height follows the frame, which
  // follows this message, and the two would feed each other.
  new Observer(function () {
    send({ kind: 'height', height: root.getBoundingClientRect().height });
  }).observe(root);

  // The size a chart is told can be wider than its frame, and only a viewBox lets it shrink. An
  // svg with a size and no viewBox would be cut off with nothing said. A nested svg is left
  // alone, and so is a width such as 100%, which is no number of pixels to draw a box from.
  function fitSvgs() {
    root.querySelectorAll('svg').forEach(function (svg) {
      var width = Number(svg.getAttribute('width'));
      var height = Number(svg.getAttribute('height'));
      if (svg.ownerSVGElement || svg.hasAttribute('viewBox') || !(width > 0 && height > 0)) return;
      svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    });
  }

  function boxOf() {
    var svg = root.querySelector('svg');
    var box = svg && svg.getBBox ? svg.getBBox() : root.getBoundingClientRect();
    return { w: box.width, h: box.height };
  }

  function nanCount() {
    var found = 0;
    root.querySelectorAll('*').forEach(function (element) {
      for (var i = 0; i < element.attributes.length; i += 1) {
        if (element.attributes[i].value.indexOf('NaN') !== -1) found += 1;
      }
    });
    return found;
  }

  function hasSize(element) {
    var box = element.getBBox();
    return box.width > 0 || box.height > 0;
  }

  // A line is one path however many rows went into it, so a path counts for its segments. An
  // arc is left out of those, which keeps a slice of a pie at one.
  function weightOf(element) {
    if (!element.matches('path')) return 1;
    var segments = (element.getAttribute('d') || '').match(/[lhvcsqt]/gi);
    return segments === null ? 1 : segments.length;
  }

  // What was drawn besides the frame of a chart: axes and tick labels are not data, and a line
  // over no rows is a path with nothing in it. Words count past a title and a subtitle, so a
  // word cloud has marks and empty axes under a heading have none. The page only needs to tell
  // none from a few, and measuring every element of a huge chart would hold up the report.
  function markCount() {
    var elements = root.querySelectorAll('svg *');
    var shapes = 0;
    var words = 0;
    for (var i = 0; i < elements.length && shapes + words < MARKS_ENOUGH + TITLE_LINES; i += 1) {
      var element = elements[i];
      if (element.closest(NOT_DATA) !== null) continue;
      if (element.matches('text')) words += 1;
      else if (element.matches(SHAPES) && hasSize(element)) shapes += weightOf(element);
    }
    return shapes + Math.max(0, words - TITLE_LINES);
  }

  function report() {
    fitSvgs();
    send({
      kind: 'report',
      nodes: root.querySelectorAll('*').length,
      svgs: root.querySelectorAll('svg').length,
      bbox: boxOf(),
      marks: markCount(),
      nan: nanCount(),
      text: (root.textContent || '').slice(0, REPORT_TEXT_CHARS),
    });
  }

  // This means loaded and nothing more: it fires after a syntax error too.
  addEventListener('load', function () {
    fitSvgs();
    send({ kind: 'ready' });
    apply(later, window, [report, SETTLE_MS]);
  });
})();
