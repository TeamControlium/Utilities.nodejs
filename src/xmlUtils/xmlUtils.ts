import { parseXmlDocument, XMLSerializer } from "slimdom";
import type { Attr as RawXmlAttr, Document as RawXmlDocument, Element as RawXmlElement, Node as RawXmlNode } from "slimdom";
import fontoxpath from "fontoxpath";
import { XMLValidator } from "fast-xml-parser";
import xmlFormatterImport from "xml-formatter";
import type { XMLFormatterOptions } from "xml-formatter";

/**
 * `xml-formatter`'s own `.d.ts` (a CJS package with no `package.json` `"type"`/`"exports"`
 * field) resolves its default export to the module namespace type, not the function it
 * actually is at runtime, under this project's `NodeNext` module resolution — confirmed
 * live: `typeof (await import("xml-formatter")).default === "function"` at runtime, every
 * time, regardless of what the type checker infers. One isolated cast here, rather than
 * scattered through the rest of this file.
 */
const xmlFormatter = xmlFormatterImport as unknown as (xml: string, options?: XMLFormatterOptions) => string;

import { JsonUtils, Log, LogLevels, Utils } from "../index.js";

/**
 * A parsed XML document, as returned by {@link XmlUtils.parse} and accepted/returned by
 * every other {@link XmlUtils} method that operates on a whole document. A thin alias
 * over `slimdom`'s own `Document` type, so a caller never needs to import that package
 * directly just to hold a value this class gives them.
 */
export type XmlDocument = RawXmlDocument;

const ELEMENT_NODE = 1;
const ATTRIBUTE_NODE = 2;

/**
 * A bare name, permissive about a single namespace prefix (`a:foo`) — this package never
 * resolves namespace URIs *itself*; see {@link XmlUtils}'s own class doc for what that
 * means in practice now that queries run through a real, namespace-aware XPath engine.
 */
const NAME_PATTERN = "[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?";
const PLAIN_ELEMENT_STEP = new RegExp(`^${NAME_PATTERN}$`);
const ATTRIBUTE_STEP = new RegExp(`^@(${NAME_PATTERN})$`);
const SIBLING_STEP = new RegExp(`^(preceding-sibling|following-sibling)::(${NAME_PATTERN})$`);

/**
 * XML utility methods for querying, manipulating, and parsing XML documents — the XML
 * counterpart to {@link JsonUtils}, mirroring its naming and shape as closely as the two
 * domains allow. All methods are static — no instantiation required.
 *
 * Deliberately built from three separate, purpose-built tools rather than one do-it-all
 * library — the same split {@link JsonUtils} gets for free from native `JSON.parse`/
 * `JSON.stringify` plus a real JSONPath engine for the one job that actually needs a
 * document model:
 * - **Validate** (`isXml`) — `fast-xml-parser`'s `XMLValidator.validate`: a pure
 *   string-in/boolean-or-reason-out check, no DOM built, no console output under any
 *   input (verified live, including on malformed/truncated/non-XML input).
 * - **Format** (`serialize`'s `{ pretty: true }`) — `xml-formatter`: a pure
 *   string-in/string-out pretty-printer, synchronous, zero console output, indent
 *   configurable. Run with `strictMode: true` as a defensive backstop — unreachable in
 *   practice, since `serialize` only ever formats a string this class itself just
 *   produced from an already-parsed document, but costs nothing to assert.
 * - **Query/update by path** (`getNodesMatchingPath`/`updateXMLDocument`) — the only job
 *   that genuinely needs a mutable document model: `slimdom` (a spec-compliant, pure-JS
 *   DOM4 implementation with zero console calls anywhere in its source) paired with
 *   `fontoxpath` (a spec-compliant, pure-JS XPath 3.1 engine — a superset of XPath 1.0 —
 *   whose only `console.log` lives in its own unused `trace()` debugging helper, which
 *   this class never calls).
 *
 * All three are pure JS (no native bindings) and fully synchronous throughout.
 *
 * ## Namespace prefixes are resolved against the document being queried
 *
 * A prefix used in a path (e.g. `pfx:foo`, or `@pfx:attr`) is resolved to whatever
 * `xmlns:pfx="..."` declaration exists anywhere in the document being queried (the first
 * one found, depth-first) — real, spec-standard XPath namespace resolution, not a literal
 * string match. A prefix that isn't declared anywhere in the document throws clearly,
 * rather than silently matching nothing. This is a deliberate simplification versus full
 * lexical scoping (a declaration found elsewhere in the tree is treated as if it were
 * in scope everywhere) — correct for the overwhelmingly common case of a document
 * declaring its namespaces once, near the root, and never rebinding a prefix partway
 * through. One consequence worth knowing: two *different* prefixes that happen to be
 * declared against the *same* namespace URI are, correctly per the XPath spec, treated as
 * the same element/attribute name — namespace equivalence is defined by URI, not by
 * which prefix string happens to spell it.
 */
export class XmlUtils {
  /**
   * Sentinel value recognised by {@link updateXMLDocument}: when a node's new value is
   * exactly this string, the matched element (and its subtree) or attribute is removed
   * entirely rather than set to the literal text. The exact same string/meaning as
   * {@link JsonUtils.SENTINEL_UNDEFINED} — one convention, shared across the framework,
   * not redefined here.
   *
   * A getter, not a static field initializer — {@link JsonUtils} and {@link XmlUtils}
   * import each other's siblings via the shared `index.ts` barrel, and a field
   * initializer reads its value synchronously at class-definition time, which can run
   * mid-way through that circular load, before `JsonUtils` itself is defined. Deferring
   * the read to first access (here, well after module loading completes) avoids that
   * entirely.
   */
  public static get SENTINEL_UNDEFINED(): string {
    return JsonUtils.SENTINEL_UNDEFINED;
  }

  /**
   * Checks whether the given item is valid XML — specifically, that it parses (or
   * already is) a document with a real root element. Mirrors {@link JsonUtils.isJson}'s
   * role, adapted to XML: there is no equivalent to JSON's "valid but a bare primitive"
   * case, since every well-formed XML document has exactly one root element by
   * definition.
   *
   * @param item - The string to check, or an already-parsed {@link XmlDocument}.
   * @returns `true` if `item` is (or parses as) a well-formed XML document.
   *
   * @example
   * XmlUtils.isXml("<a/>");     // true
   * XmlUtils.isXml("<a><b>");   // false (not well-formed — unclosed tag)
   * XmlUtils.isXml("");         // false
   * XmlUtils.isXml(undefined);  // false
   */
  static isXml(item: string | XmlDocument | undefined | null): boolean {

    ////////////////////////////////////////////////////
    //
    // Dispatches on item's own shape: null/undefined is never XML; an already-parsed
    // document is valid iff it actually has a root element; a string is checked via
    // fast-xml-parser's own validator (parses nothing into a DOM, just checks well-formedness).

    // null/undefined is never valid XML.
    if (Utils.isNullOrUndefined(item)) {
      return false;
    }
    // Already a parsed document — valid iff it actually has a root element.
    if (typeof item !== "string") {
      return !Utils.isNull(item.documentElement);
    }
    // A string — delegate to fast-xml-parser's own well-formedness check.
    return XMLValidator.validate(item) === true;
  }

  /**
   * Parses an XML string into a {@link XmlDocument}.
   *
   * Unlike {@link JsonUtils.parse}, there is no sensible default for a missing/null
   * input — JSON has an unambiguous empty value (`{}`); XML has no equivalent "empty but
   * valid" document, since every well-formed document needs exactly one real root
   * element. `xml` is therefore required, not defaulted.
   *
   * @param xml - The XML string to parse.
   * @returns The parsed document.
   * @throws {Error} If `xml` is not a string, or is not well-formed XML.
   *
   * @example
   * XmlUtils.parse("<root><a>1</a></root>");
   */
  static parse(xml: string): XmlDocument {

    ////////////////////////////////////////////////////
    //
    // Parses the string via slimdom, then explicitly checks the result actually has a root
    // element — slimdom's own parser can succeed while producing a documentElement-less
    // result for some malformed input, so this is a second, explicit well-formedness check
    // rather than trusting "didn't throw" alone. Any failure (parse error, or missing root)
    // is wrapped in a clearer, item-specific error.

    // xml must actually be a string — fail fast and clearly if not.
    Utils.assertType(xml, "string", "XmlUtils.parse", "xml");
    try {
      // Parse the string into a document.
      const doc = parseXmlDocument(xml);
      // A well-formed document must have a real root element — treat a missing one as a
      // parse failure, same as slimdom throwing outright.
      if (Utils.isNull(doc.documentElement)) {
        throw new Error("parsed document has no root element");
      }
      return doc;
    } catch (err) {
      // Parsing failed — log and throw a clearer error, including the xml itself (or just
      // its length, if it's long enough that dumping it in full wouldn't be useful).
      const errTxt = `Cannot parse item [${xml.length < 50 ? xml : `Length ${xml.length}`}] as XML: ${Utils.errorMessage(err)}`;
      Log.logErrorAndThrow(errTxt);
    }
  }

  /**
   * Serialises a {@link XmlDocument} back to an XML string. The XML equivalent of
   * `JSON.stringify` — {@link JsonUtils} never needed its own wrapper for this since
   * `JSON.stringify` is already a native global; XML has no such built-in.
   *
   * @param document - The document to serialise.
   * @param options.pretty - When `true`, indents nested elements for readability (e.g. a
   *   log line), not round-tripping, via `xml-formatter`. A single text-only child is
   *   kept inline with its element (`<b>1</b>`, not spread over three lines).
   *   Best-effort for genuinely mixed content (an element with both text *and* child
   *   elements — or comments/CDATA — as siblings): the whole subtree collapses onto one
   *   line rather than being split one-per-line, same honest limit the old hand-rolled
   *   version of this method documented. Default `false` (the original compact form).
   * @param options.indent - Number of spaces per nesting level when `pretty` is `true`.
   *   Default `2`. Ignored when `pretty` is not `true`.
   * @returns The serialised XML string.
   *
   * @example
   * XmlUtils.serialize(XmlUtils.parse("<a/>")); // => "<a/>"
   * XmlUtils.serialize(XmlUtils.parse("<a><b>1</b></a>"), { pretty: true });
   * // => "<a>\n  <b>1</b>\n</a>"
   * XmlUtils.serialize(XmlUtils.parse("<a><b>1</b></a>"), { pretty: true, indent: 4 });
   * // => "<a>\n    <b>1</b>\n</a>"
   */
  static serialize(document: XmlDocument, options?: { pretty?: boolean; indent?: number }): string {

    ////////////////////////////////////////////////////
    //
    // Always serialises to compact form first (slimdom's own XMLSerializer); if pretty
    // printing wasn't asked for, that's the whole answer. Otherwise, validate the indent
    // size and re-run the compact string through xml-formatter to indent it.

    // document must actually be a non-null object — fail fast and clearly if not.
    Utils.assertShape(document, "nonNullObject", "XmlUtils.serialize", "document");
    // Always produce the compact form first — it's both the default return value and the
    // input xml-formatter needs if pretty-printing was asked for.
    const compact = new XMLSerializer().serializeToString(document);
    if (!options?.pretty) {
      // No pretty-printing requested — the compact form is the whole answer.
      return compact;
    }
    // Pretty-printing requested — validate the indent size before using it.
    const indent = options.indent ?? 2;
    Utils.assertType(indent, "number", "XmlUtils.serialize", "options.indent");
    if (!Number.isInteger(indent) || indent < 1) {
      Log.logErrorAndThrow(`XmlUtils.serialize: [options.indent] must be a positive integer — received [${indent}]`);
    }
    // Re-run the compact string through xml-formatter to produce the indented form.
    return xmlFormatter(compact, {
      indentation: " ".repeat(indent),
      lineSeparator: "\n",
      collapseContent: true,
      strictMode: true,
    });
  }

  /**
   * Returns every node within `document` that matches the given XPath expression.
   * Mirrors {@link JsonUtils.getPropertiesMatchingPath}'s role, adapted to XML: each
   * result carries the matched node itself (an element or attribute node, from
   * `slimdom`), its parent node, and its current text/attribute value as a convenience.
   *
   * @param document - The document to query.
   * @param pathString - A valid XPath expression.
   * @returns An array of matches. Empty if nothing matches.
   * @throws {Error} If `pathString` is not a string, or the XPath expression is invalid.
   *
   * @example
   * XmlUtils.getNodesMatchingPath(XmlUtils.parse("<a><b>1</b></a>"), "/a/b");
   * // => [{ node: <b> element, parent: <a> element, value: "1" }]
   */
  static getNodesMatchingPath(
    document: XmlDocument,
    pathString: string
  ): Array<{ node: RawXmlNode; parent: RawXmlNode | null; value: string }> {

    ////////////////////////////////////////////////////
    //
    // Runs the XPath query (namespace-prefix-aware, via selectNodes), logs the match count,
    // then maps each raw matched node into the richer { node, parent, value } shape this
    // method promises. Any failure anywhere is caught, logged, and re-thrown with
    // path-specific context.

    // pathString must actually be a string — fail fast and clearly if not.
    Utils.assertType(pathString, "string", "XmlUtils.getNodesMatchingPath", "pathString");
    try {
      // Run the query itself.
      const nodes = selectNodes(pathString, document);
      Log.writeLine(LogLevels.TestDebug, `For path [${pathString}], got ${nodes.length} matches`);
      // Enrich each raw matched node with its parent and current text/attribute value.
      return nodes.map((node) => ({ node, parent: node.parentNode, value: nodeValue(node) }));
    } catch (err) {
      // Something went wrong (invalid document, malformed XPath, etc.) — log it and
      // re-throw with path-specific context rather than a bare library error.
      const errText = `Error getting XML nodes with path [${pathString}]:\n${Utils.errorMessage(err)}`;
      Log.writeLine(LogLevels.Error, errText);
      throw new Error(errText);
    }
  }

  /**
   * Returns the number of nodes within `document` that match the given XPath expression.
   * Mirrors {@link JsonUtils.getMatchingJSONPropertyCount}.
   *
   * @param document - The document to query.
   * @param pathString - A valid XPath expression.
   * @returns The number of matching nodes, or `0` if none match.
   *
   * @example
   * XmlUtils.getMatchingXMLNodeCount(XmlUtils.parse("<a><b/><b/></a>"), "/a/b"); // => 2
   */
  static getMatchingXMLNodeCount(document: XmlDocument, pathString: string): number {
    return this.getNodesMatchingPath(document, pathString).length;
  }

  /**
   * Sets, adds, or deletes a node within an XML document identified by an XPath
   * expression. Mirrors {@link JsonUtils.updateJSONObject}'s role and shape as closely
   * as the two domains allow.
   *
   * Operates on a deep clone of `currentDocument` — the original is not mutated.
   *
   * - The XPath must match zero or one node — **multiple matches always throw**,
   *   regardless of whether this is a set, an add, or a delete.
   * - If exactly **one** node matches, its value is set (element text content, or
   *   attribute value) — or, if `value` is `"_undefined"`, the matched element (and its
   *   subtree) or attribute is removed.
   * - If **zero** nodes match and `value` is `"_undefined"`: a no-op — "ensure it is not
   *   there", not an error, same as {@link JsonUtils.updateJSONObject}.
   * - If **zero** nodes match and `value` is anything else, the path is walked step by
   *   step from the document's root (which must already exist and match the path's
   *   first step — this never fabricates a document's root). Any step — predicate-bearing
   *   or not — that resolves against *existing* data to exactly one node is fine to
   *   descend through; a predicate evaluated against real data is just an ordinary
   *   query. The **first** step that comes back zero-match must be one of:
   *     - a plain element name (the default `child::` axis) — creates a new child
   *       element, appended as the current node's last child;
   *     - `@name` — creates a new attribute, but only directly onto an element that
   *       itself already resolved to exactly one existing node (this never triggers
   *       element-creation to build a missing ancestor just to hang an attribute off
   *       it);
   *     - a plain name on the `preceding-sibling::`/`following-sibling::` axis, relative
   *       to an anchor that already resolved to exactly one existing node — creates the
   *       new element immediately before/after that anchor. This is what lets a caller
   *       control sibling ordering without any extra mechanism — e.g.
   *       `/root/role/preceding-sibling::dept` with zero matches inserts `<dept>`
   *       immediately before `<role>`, wherever `<role>` currently sits.
   *   Anything else (any other predicate or axis) at that first zero-match step throws —
   *   a predicate describes a *test* against existing nodes, not a construction recipe,
   *   and "zero matches" doesn't say *why*, so there is no single correct node to build
   *   (see this package's own design note for the worked example). Every step *below*
   *   the first created one cascades the same way — plain element names only, each
   *   appended as the new child of the one just created. Every intermediate created
   *   element is empty/structural; only the final leaf gets `value` as its text content.
   *
   * @param currentDocument - The source document to update (not mutated).
   * @param pathString - A valid XPath expression identifying the node to set/add/delete.
   * @param value - The value to set, as text. Pass `"_undefined"` (or
   *   {@link SENTINEL_UNDEFINED}) to delete. XML has no native non-string leaf type
   *   (unlike JSON) — element and attribute values are always text.
   * @returns A new, deep-cloned document with the change applied.
   * @throws {Error} If `currentDocument`/`pathString`/`value` are the wrong type, if the
   *   XPath matches more than one node (at any step, for any operation), or if a
   *   zero-match create needs a step this class cannot auto-create.
   *
   * @example
   * XmlUtils.updateXMLDocument(XmlUtils.parse("<a><b>1</b></a>"), "/a/b", "2");
   * // => document serialising to "<a><b>2</b></a>"
   * XmlUtils.updateXMLDocument(XmlUtils.parse("<a/>"), "/a/b", "new");
   * // => document serialising to "<a><b>new</b></a>"  (b created)
   * XmlUtils.updateXMLDocument(XmlUtils.parse("<a><b>1</b></a>"), "/a/b", "_undefined");
   * // => document serialising to "<a/>"
   */
  static updateXMLDocument(currentDocument: XmlDocument, pathString: string, value: string): XmlDocument {

    ////////////////////////////////////////////////////
    //
    // Deep-clones currentDocument, resolves pathString to zero or one matching node on the
    // clone, then either sets/deletes that one matching node, or — if nothing matched and
    // this isn't a no-op delete — walks the path step by step from the root, creating
    // whatever's missing (see this method's own doc comment for the full creation rule
    // set). Any failure anywhere is caught, logged, and re-thrown with path-specific context.

    // All three arguments must be the expected type — fail fast and clearly if not.
    Utils.assertShape(currentDocument, "nonNullObject", "XmlUtils.updateXMLDocument", "currentDocument");
    Utils.assertType(pathString, "string", "XmlUtils.updateXMLDocument", "pathString");
    Utils.assertType(value, "string", "XmlUtils.updateXMLDocument", "value");

    Log.writeLine(LogLevels.TestDebug, `Setting [${pathString}] of XML document to [${value}]`);

    try {
      // Deep-clone currentDocument — everything from here on operates on the clone only, so
      // the caller's own document is never mutated.
      const workingDocument = currentDocument.cloneNode(true) as XmlDocument;
      // Resolve how many nodes the path currently matches — zero (no-op delete, or create),
      // one (update or delete), or more than one (ambiguous, refuse).
      const matches = this.getNodesMatchingPath(workingDocument, pathString);

      if (matches.length > 1) {
        // Path matched more than one node — ambiguous, so refuse rather than guess which one.
        throw new Error(`XPath [${pathString}] matched [${matches.length}]! Expected zero or one match.`);
      }

      if (matches.length === 1) {
        // Exactly one match — either delete it (SENTINEL_UNDEFINED) or set its value.
        if (value === this.SENTINEL_UNDEFINED) {
          Log.writeLine(LogLevels.TestDebug, `value is _undefined so will delete node [${pathString}]`);
          deleteNode(matches[0].node);
        } else {
          Log.writeLine(LogLevels.TestDebug, `Updating node [${pathString}] with value: ${value}`);
          setNodeValue(matches[0].node, value);
        }
        return workingDocument;
      }

      // Zero matches.
      if (value === this.SENTINEL_UNDEFINED) {
        // Deleting something already absent is "ensure it is not there", not an error —
        // idempotent, same as the node never having existed in the first place.
        Log.writeLine(LogLevels.TestDebug, `[${pathString}] already absent — nothing to delete`);
        return workingDocument;
      }
      // Not a delete, and nothing matched — walk the path from the root, creating whatever's
      // missing along the way.
      Log.writeLine(LogLevels.TestDebug, "no matching nodes found - will ADD node");
      createAlongPath(workingDocument, pathString, value);
      return workingDocument;
    } catch (err) {
      // Something went wrong (ambiguous match, uncreatable step, etc.) — log it and
      // re-throw with path-specific context rather than a bare error.
      const errText = `Error adding/updating/deleting node [${pathString}]: ${Utils.errorMessage(err)}`;
      Log.writeLine(LogLevels.Error, errText);
      throw new Error(errText);
    }
  }
}

/** The node whose `xmlns:*` declarations are searched to resolve a prefix — see {@link selectNodes}. */
function documentOf(node: RawXmlNode): RawXmlNode {
  const owner = (node as { ownerDocument?: RawXmlNode | null }).ownerDocument;
  return Utils.isNull(owner) ? node : (owner as RawXmlNode);
}

/**
 * Finds the first `xmlns:{prefix}` declaration anywhere under `root` (depth-first) and
 * returns its value, or `null` if the prefix isn't declared anywhere in the document. See
 * {@link XmlUtils}'s own class doc for the scoping simplification this implies.
 */
function findNamespaceURI(root: RawXmlNode, prefix: string): string | null {

  ////////////////////////////////////////////////////
  //
  // Depth-first stack-based walk of the tree under root, stopping at the first element
  // carrying an `xmlns:{prefix}` attribute. An explicit stack (not recursion) so this never
  // blows the call stack on a pathologically deep document.

  const attrName = `xmlns:${prefix}`;
  const stack: RawXmlNode[] = [root];
  while (stack.length > 0) {
    // Pop the next node to examine.
    const node = stack.pop() as RawXmlNode;
    if (node.nodeType === ELEMENT_NODE) {
      // Only elements can carry attributes — check for the namespace declaration here.
      const attr = (node as RawXmlElement).getAttributeNode(attrName);
      if (!Utils.isNull(attr)) {
        // Found it — this is the declared namespace URI for this prefix.
        return attr.value;
      }
    }
    // Not found on this node — push its children so they get visited too. Pushed in
    // reverse order so the stack still pops them in original document order (depth-first,
    // left-to-right).
    const children = node.childNodes;
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]);
    }
  }
  // Walked the whole tree without finding a matching declaration — the prefix isn't
  // declared anywhere in this document.
  return null;
}

/**
 * Evaluates `expression` relative to `contextNode`, resolving any namespace prefix
 * against the owning document — see {@link XmlUtils}'s own class doc for what that means.
 */
function selectNodes(expression: string, contextNode: RawXmlNode): RawXmlNode[] {
  const root = documentOf(contextNode);
  return fontoxpath.evaluateXPathToNodes<RawXmlNode>(expression, contextNode, null, null, {
    namespaceResolver: (prefix: string) => findNamespaceURI(root, prefix),
  });
}

/** The matched node's current value — an attribute's value, or an element's text content. */
function nodeValue(node: RawXmlNode): string {
  return node.nodeType === ATTRIBUTE_NODE ? (node as RawXmlAttr).value : (node.textContent ?? "");
}

/** Sets the matched node's value — an attribute's value, or an element's text content. */
function setNodeValue(node: RawXmlNode, value: string): void {
  if (node.nodeType === ATTRIBUTE_NODE) {
    (node as RawXmlAttr).value = value;
  } else {
    node.textContent = value;
  }
}

/** Removes the matched node — an attribute from its owning element, or an element (and its subtree) from its parent. */
function deleteNode(node: RawXmlNode): void {
  if (node.nodeType === ATTRIBUTE_NODE) {
    const attr = node as RawXmlAttr;
    if (!Utils.isNull(attr.ownerElement)) {
      attr.ownerElement.removeAttribute(attr.name);
    }
  } else if (!Utils.isNull(node.parentNode)) {
    node.parentNode.removeChild(node);
  }
}

/**
 * Splits an XPath expression into its `/`-separated top-level steps, ignoring any `/`
 * that appears inside a `[...]` predicate. A leading `/` (absolute path) produces a
 * leading empty segment, which is dropped — it marks "from the root", it is not itself a
 * step.
 */
function splitTopLevelSteps(pathString: string): string[] {

  ////////////////////////////////////////////////////
  //
  // Scans pathString one character at a time, tracking bracket-nesting depth so a '/'
  // inside a '[...]' predicate is never mistaken for a step separator, only one at depth 0.

  const steps: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of pathString) {
    // Track predicate bracket nesting — a '/' only counts as a step separator outside any
    // '[...]' predicate.
    if (char === "[") depth++;
    if (char === "]") depth--;
    if (char === "/" && depth === 0) {
      // A top-level separator — end the current step and start a new one.
      steps.push(current);
      current = "";
    } else {
      // Part of the current step's text — keep accumulating.
      current += char;
    }
  }
  // Push whatever's left after the loop as the final step.
  steps.push(current);
  // A leading '/' (absolute path) produces an empty first segment — that's "from the root",
  // not a step in its own right, so drop it if present.
  return steps[0] === "" ? steps.slice(1) : steps;
}

/**
 * Walks `pathString` step by step from `document`'s root, creating from the first
 * zero-match step onward, and sets the final leaf to `value`. See
 * {@link XmlUtils.updateXMLDocument}'s own doc comment for the full rule set this
 * implements.
 */
function createAlongPath(document: XmlDocument, pathString: string, value: string): void {

  ////////////////////////////////////////////////////
  //
  // Walks pathString's steps one at a time from the document root, descending through any
  // step that already resolves to exactly one existing node (an ordinary query, even if it
  // carries a predicate). The first step that resolves to zero matches is where creation
  // begins — from there, every remaining step (including that first one) is created in
  // turn via createOneStep, cascading downward, with the final leaf's value set at the end.

  // Break the path into its top-level steps (predicate-aware — a '/' inside '[...]' is not
  // a step separator).
  const steps = splitTopLevelSteps(pathString);
  if (steps.length === 0) {
    throw new Error(`XPath [${pathString}] has no steps to create.`);
  }

  // Start walking from the document itself.
  let context: RawXmlNode = document;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    // Try resolving this step against the current context — an ordinary query, predicate
    // or not.
    const found = selectNodes(step, context);
    if (found.length > 1) {
      // This step matched more than one node — ambiguous, so refuse rather than guess which
      // one to descend into.
      throw new Error(`XPath step [${step}] (within [${pathString}]) matched [${found.length}]! Expected zero or one match.`);
    }
    if (found.length === 1) {
      // Exactly one match — descend into it and move on to the next step.
      context = found[0];
      continue;
    }

    // Zero matches at this step — this is where creation starts.
    if (i === 0) {
      // The very first step (the document's root) can never be auto-created — there's no
      // sensible "create a root" operation.
      throw new Error(
        `XPath [${pathString}] — the document's root ([${step}]) does not exist; auto-creation never fabricates a document root.`
      );
    }
    // Create every remaining step in turn, cascading downward from the current context —
    // each newly-created node becomes the parent context for the next one.
    for (let j = i; j < steps.length; j++) {
      context = createOneStep(document, context, steps[j], j === i);
      if (j === steps.length - 1) {
        // The final leaf gets value as its actual content — every intermediate created
        // node stays empty/structural.
        setNodeValue(context, value);
      }
    }
    return;
  }

  // Every step resolved individually — contradicts updateXMLDocument's own check that the
  // whole expression was zero-match. Should be unreachable; fail loudly rather than
  // silently returning without having created or set anything.
  throw new Error(`XPath [${pathString}] — internal error: every step resolved individually, but the whole expression was reported as zero-match.`);
}

/**
 * Creates one step of a create-cascade. `isFirstCreatedStep` gates which step shapes are
 * allowed — see {@link XmlUtils.updateXMLDocument}'s own doc comment.
 */
function createOneStep(document: XmlDocument, context: RawXmlNode, step: string, isFirstCreatedStep: boolean): RawXmlNode {

  ////////////////////////////////////////////////////
  //
  // Decides what kind of node a single step shape creates: a plain element name is always
  // creatable, at any depth in the cascade; an attribute or sibling-axis step is only
  // creatable as the FIRST created step (isFirstCreatedStep) — see updateXMLDocument's own
  // doc comment for why. Anything else throws — there's no sensible construction recipe
  // for an arbitrary predicate or axis.

  // A plain element name is always creatable — append it as a new child of context.
  if (PLAIN_ELEMENT_STEP.test(step)) {
    return appendNewElement(document, context, step);
  }
  if (!isFirstCreatedStep) {
    // Only a plain element name is creatable below the first missing step — an attribute or
    // sibling step only makes sense anchored directly against already-existing data.
    throw new Error(`Cannot auto-create step [${step}] — only a plain element name is creatable below the first missing step.`);
  }
  // An attribute step (@name) — only reachable here because isFirstCreatedStep is true.
  const attrMatch = step.match(ATTRIBUTE_STEP);
  if (attrMatch) {
    return createAttribute(context, attrMatch[1]);
  }
  // A preceding-sibling::/following-sibling:: step — same "first created step only" rule.
  const siblingMatch = step.match(SIBLING_STEP);
  if (siblingMatch) {
    return insertSibling(document, context, siblingMatch[1] as "preceding-sibling" | "following-sibling", siblingMatch[2]);
  }
  // Not a plain element, attribute, or sibling step — no sensible construction recipe for
  // this shape (e.g. an arbitrary predicate or axis).
  throw new Error(
    `Cannot auto-create step [${step}] — not a plain element name, an attribute (@name), or a preceding-sibling::/following-sibling:: step.`
  );
}

/** Creates a new element named `name`, appended as `context`'s last child — `context` must itself be an element. */
function appendNewElement(document: XmlDocument, context: RawXmlNode, name: string): RawXmlNode {
  // Only an element can have element children — refuse otherwise.
  if (context.nodeType !== ELEMENT_NODE) {
    throw new Error(`Cannot create element [${name}] — its intended parent is not an element.`);
  }
  const element = document.createElement(name);
  context.appendChild(element);
  return element;
}

/** Creates a new, empty attribute named `name` directly on `context` — `context` must itself be an element. */
function createAttribute(context: RawXmlNode, name: string): RawXmlNode {
  // Only an element can carry attributes — refuse otherwise.
  if (context.nodeType !== ELEMENT_NODE) {
    throw new Error(`Cannot create attribute [@${name}] — its intended parent is not an element.`);
  }
  const element = context as RawXmlElement;
  // Create the attribute with an empty value, then read the actual attribute node straight
  // back — setNodeValue (called next by the caller) needs the node itself, not just the
  // fact that setAttribute succeeded.
  element.setAttribute(name, "");
  const attr = element.getAttributeNode(name);
  if (Utils.isNull(attr)) {
    throw new Error(`Failed to create attribute [@${name}] — not found immediately after creation.`);
  }
  return attr;
}

/** Creates a new element named `name`, inserted immediately before/after `anchor` (per `axis`) among `anchor`'s own siblings. */
function insertSibling(
  document: XmlDocument,
  anchor: RawXmlNode,
  axis: "preceding-sibling" | "following-sibling",
  name: string
): RawXmlNode {
  // anchor must have a parent to insert a sibling into.
  const parent = anchor.parentNode;
  if (Utils.isNull(parent)) {
    throw new Error(`Cannot create [${axis}::${name}] — its anchor node has no parent.`);
  }
  const element = document.createElement(name);
  // insertBefore(..., anchor) places it immediately before anchor (preceding-sibling);
  // insertBefore(..., anchor.nextSibling) places it immediately after (following-sibling) —
  // inserting before "the node after anchor" (or at the end, if nextSibling is null).
  parent.insertBefore(element, axis === "preceding-sibling" ? anchor : anchor.nextSibling);
  return element;
}
