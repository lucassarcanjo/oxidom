'use strict';
// XML documents (ROADMAP Stage 3 `xml`, DESIGN §38): DOMParser for the XML types, XMLSerializer, `new JSDOM(x,
// { contentType: xml })`, and innerHTML / outerHTML / insertAdjacentHTML / createContextualFragment on nodes of
// XML documents. A port of jsdom 30's glue (refs/jsdom/lib/jsdom/browser/parser/xml.js,
// living/domparsing/*.js) over the same two libraries jsdom uses, loaded on first use: saxes tokenizes (so
// well-formedness errors and their messages are jsdom's), and the tree is built through the public DOM
// (createElementNS, setAttributeNS, appendChild); w3c-xmlserializer serializes by reading the public DOM.
// "XML document" means a document whose parsing mode is XML: the HTML_DOC bit is clear (createDocument,
// `new Document()`, the documents made here).

const rt = require('./runtime.cjs');

const { V, F, M, NS } = rt;
let SaxesParser; // saxes, loaded on the first XML parse (startup cost, DESIGN §15.2)
let serializeXml; // w3c-xmlserializer, loaded on the first XML serialization

const PARSERERROR_NS = 'http://www.mozilla.org/newlayout/xml/parsererror.xml';

/**
 * True when `node` belongs to an XML document (every node carries its document's HTML_DOC bit). Anything without
 * a node id (an Attr, a non-node receiver) is not: the HTML path keeps handling (and rejecting) it.
 */
function inXmlDocument(node) {
  const id = node?._i;
  return typeof id === 'number' && id > 0 && (V.T[V.off(id) + F.META] & M.HTML_DOC) === 0;
}

// ------------------------------------------------------------------------------------------ parsing

const HTML5_DOCTYPE = /<!doctype html>/i;
const PUBLIC_DOCTYPE = /<!doctype\s+([^\s]+)\s+public\s+"([^"]+)"\s+"([^"]+)"/i;
const SYSTEM_DOCTYPE = /<!doctype\s+([^\s]+)\s+system\s+"([^"]+)"/i;
const CUSTOM_NAME_DOCTYPE = /<!doctype\s+([^\s>]+)/i;

/** jsdom `parseDocType`: name, public id and system id out of the doctype's text. */
function docTypeParts(text) {
  if (HTML5_DOCTYPE.test(text)) return ['html', '', ''];
  const pub = PUBLIC_DOCTYPE.exec(text);
  if (pub !== null) return [pub[1], pub[2], pub[3]];
  const sys = SYSTEM_DOCTYPE.exec(text);
  if (sys !== null) return [sys[1], '', sys[2]];
  return [CUSTOM_NAME_DOCTYPE.exec(text)[1] || 'html', '', ''];
}

const isTemplate = (el) => el.localName === 'template' && el.namespaceURI === NS.HTML;

/**
 * jsdom `createParser`: parses `markup` into `root` (a document, or a fragment with `fragment: true`); `fileName`
 * (the document URL of a browsing context's document) prefixes error messages.
 * Throws a SyntaxError DOMException with saxes's message at the first well-formedness error.
 */
function parseInto(root, markup, { fragment = false, resolvePrefix = undefined, fileName = undefined } = {}) {
  SaxesParser ??= require('saxes').SaxesParser; // eslint-disable-line global-require
  const parser = new SaxesParser({
    fragment,
    resolvePrefix,
    fileName,
    xmlns: true,
    defaultXMLVersion: '1.0',
    forceXMLVersion: true,
  });
  const stack = [root];
  const doc = root.nodeType === 9 ? root : root.ownerDocument;
  const top = () => stack[stack.length - 1];
  // Nodes inside a template go to its contents, which live in the template's inert document.
  const parent = () => (top().nodeType === 1 && isTemplate(top()) ? top().content : top());
  const owner = () => (top().nodeType === 1 && isTemplate(top()) ? top().content.ownerDocument : doc);

  parser.on('text', (data) => {
    // A document records no text outside its root element.
    if (fragment || stack.length > 1) parent().appendChild(owner().createTextNode(data));
  });
  parser.on('cdata', (data) => parent().appendChild(owner().createCDATASection(data)));
  parser.on('opentag', (tag) => {
    const qname = tag.prefix === '' ? tag.local : `${tag.prefix}:${tag.local}`;
    const el = owner().createElementNS(tag.uri === '' ? null : tag.uri, qname);
    for (const a of Object.values(tag.attributes)) {
      el.setAttributeNS(a.uri === '' ? null : a.uri, a.prefix === '' ? a.local : `${a.prefix}:${a.local}`, a.value);
    }
    parent().appendChild(el);
    stack.push(el);
  });
  parser.on('closetag', () => stack.pop());
  parser.on('comment', (data) => parent().appendChild(owner().createComment(data)));
  parser.on('processinginstruction', ({ target, body }) => {
    parent().appendChild(owner().createProcessingInstruction(target, body));
  });
  parser.on('doctype', (dt) => {
    const [name, publicId, systemId] = docTypeParts(`<!doctype ${dt}>`);
    parent().appendChild(owner().implementation.createDocumentType(name, publicId, systemId));
    // jsdom: the internal subset's simple entity declarations, for saxes to expand
    for (const [, n, value] of dt.matchAll(/<!ENTITY ([^ ]+) "([^"]+)">/g)) {
      if (!(n in parser.ENTITIES)) parser.ENTITIES[n] = value;
    }
  });
  parser.on('error', (err) => {
    throw new globalThis.DOMException(err.message, 'SyntaxError');
  });
  parser.write(markup).close();
  return root;
}

/** jsdom `parseFragment` for an XML document: a fragment of `context`'s document. */
function parseFragment(markup, context) {
  const frag = context.ownerDocument.createDocumentFragment();
  // saxes wants undefined, not null, for an unknown prefix
  return parseInto(frag, markup, { fragment: true, resolvePrefix: (prefix) => context.lookupNamespaceURI(prefix) || undefined });
}

/** A new XML-mode document whose wrapper is a Document (jsdom's DOMParser and JSDOM XML documents). */
function newXmlDocument(contentType, url) {
  const d = new rt.classes.Document();
  d._ct = contentType;
  d._url = url;
  return d;
}

/** DOMParser.parseFromString for an XML type; a well-formedness error gives jsdom's parsererror document. */
function parseXmlDocument(string, contentType, url) {
  const d = newXmlDocument(contentType, url);
  try {
    return parseInto(d, String(string).toWellFormed());
  } catch (e) {
    const err = newXmlDocument(contentType, url);
    const el = err.createElementNS(PARSERERROR_NS, 'parsererror');
    el.textContent = e.message;
    err.appendChild(el);
    return err;
  }
}

// -------------------------------------------------------------------------------------- serializing

function serialize(node, requireWellFormed) {
  serializeXml ??= require('w3c-xmlserializer'); // eslint-disable-line global-require
  try {
    return serializeXml(node, { requireWellFormed });
  } catch (e) {
    throw rt.domError(6, e.message);
  }
}

/** jsdom `fragmentSerialization` for XML documents (innerHTML / outerHTML getters). */
function fragmentSerialization(node, outer) {
  if (outer) return serialize(node, true);
  let s = '';
  for (let c = node.firstChild; c !== null; c = c.nextSibling) s += serialize(c, true);
  return s;
}

/** `JSDOM#serialize()` for an XML document: its children, not required to be well-formed. */
function serializeDocument(doc) {
  let s = '';
  for (let c = doc.firstChild; c !== null; c = c.nextSibling) s += serialize(c, false);
  return s;
}

class XMLSerializer {
  serializeToString(root) {
    if (arguments.length === 0) {
      throw new TypeError("Failed to execute 'serializeToString' on 'XMLSerializer': 1 argument required, but only 0 present.");
    }
    if (!(root instanceof rt.classes.Node)) {
      throw new TypeError("Failed to execute 'serializeToString' on 'XMLSerializer': parameter 1 is not of type 'Node'.");
    }
    return serialize(root, false);
  }
}
Object.defineProperty(XMLSerializer.prototype, Symbol.toStringTag, { value: 'XMLSerializer', configurable: true });

// ------------------------------------------------------------------------------------------ install

/** Replaces `C.prototype[prop]`'s getter / setter / method with one that takes XML documents' nodes. */
function wrapMember(C, prop, xml) {
  const d = Object.getOwnPropertyDescriptor(C.prototype, prop);
  const nd = { ...d };
  // computed-key accessors keep the names `get innerHTML` / `set innerHTML`
  const named = {
    get [prop]() {
      return inXmlDocument(this) ? xml.get.call(this) : d.get.call(this);
    },
    set [prop](v) {
      if (inXmlDocument(this)) xml.set.call(this, v);
      else d.set.call(this, v);
    },
  };
  const acc = Object.getOwnPropertyDescriptor(named, prop);
  if (xml.get !== undefined) nd.get = acc.get;
  if (xml.set !== undefined) nd.set = acc.set;
  if (xml.value !== undefined) {
    const orig = d.value;
    nd.value = {
      [prop](...args) {
        return inXmlDocument(this) ? xml.value.apply(this, args) : orig.apply(this, args);
      },
    }[prop];
    Object.defineProperty(nd.value, 'length', { value: orig.length });
  }
  Object.defineProperty(C.prototype, prop, nd);
}

const markupString = (v) => (v === null ? '' : String(v));

function install(_rt, dom) {
  const C = rt.classes;
  C.XMLSerializer = XMLSerializer;

  const innerHTML = {
    get() {
      return fragmentSerialization(this, false);
    },
    set(v) {
      const context = this instanceof C.ShadowRoot ? this.host : this;
      const frag = parseFragment(markupString(v), context);
      (this.nodeType === 1 && isTemplate(this) ? this.content : this).replaceChildren(frag);
    },
  };
  wrapMember(dom.Element, 'innerHTML', innerHTML);
  wrapMember(C.ShadowRoot, 'innerHTML', innerHTML);

  wrapMember(dom.Element, 'outerHTML', {
    get() {
      return fragmentSerialization(this, true);
    },
    set(v) {
      let parent = this.parentNode;
      if (parent === null) return;
      if (parent.nodeType === 9) throw rt.domError(10, 'Modifications are not allowed for this document');
      if (parent.nodeType === 11) parent = this.ownerDocument.createElementNS(NS.HTML, 'body');
      const frag = parseFragment(markupString(v), parent);
      this.parentNode.replaceChild(frag, this);
    },
  });

  wrapMember(dom.Element, 'insertAdjacentHTML', {
    value(position, text) {
      if (arguments.length < 2) {
        throw new TypeError(`Failed to execute 'insertAdjacentHTML' on 'Element': 2 arguments required, but only ${arguments.length} present.`);
      }
      const pos = rt.asciiLower(String(position));
      let context;
      if (pos === 'beforebegin' || pos === 'afterend') {
        context = this.parentNode;
        if (context === null || context.nodeType === 9) {
          throw rt.domError(10, 'Cannot insert HTML adjacent to parent-less nodes or children of document nodes.');
        }
      } else if (pos === 'afterbegin' || pos === 'beforeend') context = this;
      else throw rt.domError(4, 'Must provide one of "beforebegin", "afterbegin", "beforeend", or "afterend".');
      if (context.nodeType !== 1) context = this.ownerDocument.createElement('body');
      const frag = parseFragment(String(text), context);
      if (pos === 'beforebegin') this.parentNode.insertBefore(frag, this);
      else if (pos === 'afterbegin') this.insertBefore(frag, this.firstChild);
      else if (pos === 'beforeend') this.appendChild(frag);
      else this.parentNode.insertBefore(frag, this.nextSibling);
    },
  });

  // Range#createContextualFragment: XML fragment parsing when the range's start node is in an XML document
  const ccf = Object.getOwnPropertyDescriptor(C.Range.prototype, 'createContextualFragment').value;
  Object.defineProperty(C.Range.prototype, 'createContextualFragment', {
    value: {
      createContextualFragment(fragment) {
        const node = this.startContainer;
        // jsdom handles these start nodes (others are its "Internal error: Invalid range start node")
        const t = node.nodeType;
        if (arguments.length === 0 || !inXmlDocument(node) || t === 7 || t === 10) return ccf.apply(this, arguments);
        let element = null;
        if (t === 1) element = node;
        else if (t === 3 || t === 4 || t === 8) element = node.parentElement;
        if (element === null) element = (node.nodeType === 9 ? node : node.ownerDocument).createElementNS(NS.HTML, 'body');
        return parseFragment(String(fragment), element);
      },
    }.createContextualFragment,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

module.exports = { install, inXmlDocument, parseInto, parseXmlDocument, newXmlDocument, serializeDocument, XMLSerializer };
