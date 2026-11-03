import { XmlUtils } from "./xmlUtils.js";

describe("XmlUtils.isXml", () => {

  it("returns true for a well-formed XML string", () => {
    expect(XmlUtils.isXml("<a/>")).toBe(true);
  });

  it("returns true for an already-parsed document", () => {
    expect(XmlUtils.isXml(XmlUtils.parse("<a/>"))).toBe(true);
  });

  it("returns false for not-well-formed XML (unclosed tag)", () => {
    expect(XmlUtils.isXml("<a><b>")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(XmlUtils.isXml("")).toBe(false);
  });

  it("returns false for undefined and null", () => {
    expect(XmlUtils.isXml(undefined)).toBe(false);
    expect(XmlUtils.isXml(null)).toBe(false);
  });
});

describe("XmlUtils.parse / XmlUtils.serialize", () => {

  it("round-trips a simple document", () => {
    const doc = XmlUtils.parse("<root><a>1</a></root>");
    expect(XmlUtils.serialize(doc)).toBe("<root><a>1</a></root>");
  });

  it("throws on not-well-formed XML", () => {
    expect(() => XmlUtils.parse("<a><b>")).toThrow(/Cannot parse item/);
  });

  it("throws on a non-string input", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => XmlUtils.parse(42 as any)).toThrow(/\[xml\] not 'string' type/);
  });

  describe("{ pretty: true }", () => {

    it("indents nested elements two spaces per depth level", () => {
      const doc = XmlUtils.parse("<a><b><c>deep</c></b></a>");
      expect(XmlUtils.serialize(doc, { pretty: true })).toBe("<a>\n  <b>\n    <c>deep</c>\n  </b>\n</a>");
    });

    it("keeps a single text-only child inline on the same line as its element", () => {
      const doc = XmlUtils.parse("<role>admin</role>");
      expect(XmlUtils.serialize(doc, { pretty: true })).toBe("<role>admin</role>");
    });

    it("preserves attributes on the opening tag", () => {
      const doc = XmlUtils.parse('<role wibble="wobble">admin</role>');
      expect(XmlUtils.serialize(doc, { pretty: true })).toBe('<role wibble="wobble">admin</role>');
    });

    it("renders a childless element as self-closing", () => {
      const doc = XmlUtils.parse("<a><empty/></a>");
      expect(XmlUtils.serialize(doc, { pretty: true })).toBe("<a>\n  <empty/>\n</a>");
    });

    it("renders multiple element siblings each on their own indented line", () => {
      const doc = XmlUtils.parse("<root><name>harry</name><role>admin</role></root>");
      expect(XmlUtils.serialize(doc, { pretty: true })).toBe("<root>\n  <name>harry</name>\n  <role>admin</role>\n</root>");
    });

    it("renders CDATA and comments", () => {
      const doc = XmlUtils.parse("<a><note><![CDATA[raw <stuff>]]></note><!--a comment--></a>");
      expect(XmlUtils.serialize(doc, { pretty: true }))
        .toBe("<a>\n  <note><![CDATA[raw <stuff>]]></note>\n  <!--a comment-->\n</a>");
    });

    it("escapes special characters in text content and attribute values", () => {
      const doc = XmlUtils.parse("<a><b>1 &lt; 2 &amp; 3 &gt; 0</b></a>");
      expect(XmlUtils.serialize(doc, { pretty: true })).toBe("<a>\n  <b>1 &lt; 2 &amp; 3 &gt; 0</b>\n</a>");
    });

    it("ignores whitespace-only text between sibling elements rather than doubling up indentation", () => {
      const doc = XmlUtils.parse("<root>\n  <a>1</a>\n  <b>2</b>\n</root>");
      expect(XmlUtils.serialize(doc, { pretty: true })).toBe("<root>\n  <a>1</a>\n  <b>2</b>\n</root>");
    });

    it("omits the pretty option entirely and still gets the original compact form", () => {
      const doc = XmlUtils.parse("<a><b>1</b></a>");
      expect(XmlUtils.serialize(doc)).toBe("<a><b>1</b></a>");
    });

    it("indents with a custom number of spaces via options.indent", () => {
      const doc = XmlUtils.parse("<a><b>1</b></a>");
      expect(XmlUtils.serialize(doc, { pretty: true, indent: 4 })).toBe("<a>\n    <b>1</b>\n</a>");
    });

    it("rejects a non-positive-integer indent", () => {
      const doc = XmlUtils.parse("<a/>");
      expect(() => XmlUtils.serialize(doc, { pretty: true, indent: 0 })).toThrow(/\[options\.indent\] must be a positive integer/);
      expect(() => XmlUtils.serialize(doc, { pretty: true, indent: 1.5 })).toThrow(/\[options\.indent\] must be a positive integer/);
    });
  });
});

describe("XmlUtils namespace prefix resolution", () => {

  it("resolves a prefix against the document's own xmlns declaration", () => {
    const doc = XmlUtils.parse('<a><pfx:b xmlns:pfx="urn:x">1</pfx:b></a>');
    expect(XmlUtils.getMatchingXMLNodeCount(doc, "/a/pfx:b")).toBe(1);
  });

  it("throws clearly when a path uses a prefix that is not declared anywhere in the document", () => {
    const doc = XmlUtils.parse("<a><b>1</b></a>");
    expect(() => XmlUtils.getNodesMatchingPath(doc, "//undeclared:b")).toThrow(/prefix undeclared could not be resolved/);
  });

  it("treats two different prefixes bound to the same namespace URI as the same name", () => {
    const doc = XmlUtils.parse('<a><x:b xmlns:x="urn:same">1</x:b><y:b xmlns:y="urn:same">2</y:b></a>');
    expect(XmlUtils.getMatchingXMLNodeCount(doc, "//x:b")).toBe(2);
  });
});

describe("XmlUtils.getNodesMatchingPath / XmlUtils.getMatchingXMLNodeCount", () => {

  it("returns every matching node with its value", () => {
    const doc = XmlUtils.parse("<a><b>1</b><b>2</b></a>");
    const matches = XmlUtils.getNodesMatchingPath(doc, "/a/b");
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.value)).toEqual(["1", "2"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(XmlUtils.getNodesMatchingPath(XmlUtils.parse("<a/>"), "/a/missing")).toEqual([]);
  });

  it("matches an attribute node, with its value", () => {
    const doc = XmlUtils.parse('<a id="42"/>');
    const matches = XmlUtils.getNodesMatchingPath(doc, "/a/@id");
    expect(matches).toHaveLength(1);
    expect(matches[0].value).toBe("42");
  });

  it("getMatchingXMLNodeCount returns just the count", () => {
    expect(XmlUtils.getMatchingXMLNodeCount(XmlUtils.parse("<a><b/><b/></a>"), "/a/b")).toBe(2);
    expect(XmlUtils.getMatchingXMLNodeCount(XmlUtils.parse("<a/>"), "/a/missing")).toBe(0);
  });
});

describe("XmlUtils.updateXMLDocument", () => {

  describe("one match — update", () => {

    it("updates an existing element's text content", () => {
      const result = XmlUtils.updateXMLDocument(XmlUtils.parse("<a><b>1</b></a>"), "/a/b", "2");
      expect(XmlUtils.serialize(result)).toBe("<a><b>2</b></a>");
    });

    it("updates an existing attribute's value", () => {
      const result = XmlUtils.updateXMLDocument(XmlUtils.parse('<a id="1"/>'), "/a/@id", "2");
      expect(XmlUtils.serialize(result)).toBe('<a id="2"/>');
    });

    it("does not mutate the original document", () => {
      const original = XmlUtils.parse("<a><b>1</b></a>");
      XmlUtils.updateXMLDocument(original, "/a/b", "2");
      expect(XmlUtils.serialize(original)).toBe("<a><b>1</b></a>");
    });

    it("updates via a predicate that resolves against existing data", () => {
      const doc = XmlUtils.parse("<root><X>one</X><X>two</X></root>");
      const result = XmlUtils.updateXMLDocument(doc, "/root/X[last()]", "updated");
      expect(XmlUtils.serialize(result)).toBe("<root><X>one</X><X>updated</X></root>");
    });
  });

  describe("multiple matches — throws, regardless of operation", () => {

    it("throws when updating a path that matches more than one node", () => {
      expect(() => XmlUtils.updateXMLDocument(XmlUtils.parse("<a><b>1</b><b>2</b></a>"), "/a/b", "x"))
        .toThrow(/matched \[2\]! Expected zero or one match/);
    });

    it("throws when deleting a path that matches more than one node", () => {
      expect(() => XmlUtils.updateXMLDocument(XmlUtils.parse("<a><b>1</b><b>2</b></a>"), "/a/b", XmlUtils.SENTINEL_UNDEFINED))
        .toThrow(/matched \[2\]! Expected zero or one match/);
    });
  });

  describe("delete (SENTINEL_UNDEFINED)", () => {

    it("deletes an existing element, with its subtree", () => {
      const result = XmlUtils.updateXMLDocument(XmlUtils.parse("<a><b><c>1</c></b></a>"), "/a/b", XmlUtils.SENTINEL_UNDEFINED);
      expect(XmlUtils.serialize(result)).toBe("<a/>");
    });

    it("deletes an existing attribute, leaving the element otherwise untouched", () => {
      const result = XmlUtils.updateXMLDocument(XmlUtils.parse('<a id="1">text</a>'), "/a/@id", XmlUtils.SENTINEL_UNDEFINED);
      expect(XmlUtils.serialize(result)).toBe("<a>text</a>");
    });

    it("deleting an element that does not exist is a no-op", () => {
      const result = XmlUtils.updateXMLDocument(XmlUtils.parse("<a><b>1</b></a>"), "/a/missing", XmlUtils.SENTINEL_UNDEFINED);
      expect(XmlUtils.serialize(result)).toBe("<a><b>1</b></a>");
    });

    it("deleting an attribute that does not exist is a no-op", () => {
      const result = XmlUtils.updateXMLDocument(XmlUtils.parse("<a/>"), "/a/@missing", XmlUtils.SENTINEL_UNDEFINED);
      expect(XmlUtils.serialize(result)).toBe("<a/>");
    });

    it("a zero-match delete behind a predicate is still a no-op, not an error", () => {
      const result = XmlUtils.updateXMLDocument(XmlUtils.parse("<root><X>one</X></root>"), "/root/X[last()]/missing", XmlUtils.SENTINEL_UNDEFINED);
      expect(XmlUtils.serialize(result)).toBe("<root><X>one</X></root>");
    });
  });

  describe("zero matches — create: plain element cascade", () => {

    it("adds a single missing child element with the given text", () => {
      const result = XmlUtils.updateXMLDocument(XmlUtils.parse("<a/>"), "/a/b", "new");
      expect(XmlUtils.serialize(result)).toBe("<a><b>new</b></a>");
    });

    it("appends as the last child when siblings already exist", () => {
      const result = XmlUtils.updateXMLDocument(XmlUtils.parse("<root><name>harry</name><role>admin</role></root>"), "/root/dept", "reception");
      expect(XmlUtils.serialize(result)).toBe("<root><name>harry</name><role>admin</role><dept>reception</dept></root>");
    });

    it("cascades through multiple missing levels, each intermediate empty, only the leaf gets the value", () => {
      const result = XmlUtils.updateXMLDocument(XmlUtils.parse("<root/>"), "/root/a/b/c", "deep");
      expect(XmlUtils.serialize(result)).toBe("<root><a><b><c>deep</c></b></a></root>");
    });

    it("creates relative to an anchor resolved via a predicate against existing data", () => {
      const doc = XmlUtils.parse("<root><X>one</X><X>two</X></root>");
      const result = XmlUtils.updateXMLDocument(doc, "/root/X[last()]/Y", "created-value");
      expect(XmlUtils.serialize(result)).toBe("<root><X>one</X><X>two<Y>created-value</Y></X></root>");
    });

    it("throws when the document's root itself does not match the path", () => {
      expect(() => XmlUtils.updateXMLDocument(XmlUtils.parse("<a/>"), "/notA/b", "x"))
        .toThrow(/the document's root \(\[notA\]\) does not exist/);
    });
  });

  describe("zero matches — create: attributes", () => {

    it("adds a new attribute onto an element that already exists", () => {
      const result = XmlUtils.updateXMLDocument(XmlUtils.parse("<role>admin</role>"), "/role/@wibble", "wobble");
      expect(XmlUtils.serialize(result)).toBe('<role wibble="wobble">admin</role>');
    });

    it("throws rather than creating a missing ancestor just to hang an attribute off it", () => {
      expect(() => XmlUtils.updateXMLDocument(XmlUtils.parse("<root/>"), "/root/missing/@wibble", "wobble"))
        .toThrow(/only a plain element name is creatable below the first missing step/);
    });
  });

  describe("zero matches — create: sibling-axis ordering", () => {

    it("inserts a new element immediately BEFORE an existing anchor via preceding-sibling::", () => {
      const doc = XmlUtils.parse("<root><name>harry</name><role>admin</role></root>");
      const result = XmlUtils.updateXMLDocument(doc, "/root/role/preceding-sibling::dept", "reception");
      expect(XmlUtils.serialize(result)).toBe("<root><name>harry</name><dept>reception</dept><role>admin</role></root>");
    });

    it("inserts a new element immediately AFTER an existing anchor via following-sibling::", () => {
      const doc = XmlUtils.parse("<root><name>harry</name><role>admin</role></root>");
      const result = XmlUtils.updateXMLDocument(doc, "/root/name/following-sibling::dept", "reception");
      expect(XmlUtils.serialize(result)).toBe("<root><name>harry</name><dept>reception</dept><role>admin</role></root>");
    });
  });

  describe("zero matches — create: predicate at the missing step is ill-posed, throws", () => {

    it("throws for a predicate step with zero matches — ambiguous which edit would make it true", () => {
      expect(() => XmlUtils.updateXMLDocument(XmlUtils.parse("<A><Y/></A>"), "/A/*[1][self::X]", "x"))
        .toThrow(/not a plain element name, an attribute \(@name\), or a preceding-sibling::\/following-sibling:: step/);
    });

    it("throws for a predicate-bearing step with zero matches even mid-path", () => {
      expect(() => XmlUtils.updateXMLDocument(XmlUtils.parse("<root/>"), "/root/X[last()]/Y", "x"))
        .toThrow(/not a plain element name, an attribute \(@name\), or a preceding-sibling::\/following-sibling:: step/);
    });
  });
});
